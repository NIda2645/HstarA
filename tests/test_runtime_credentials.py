import os
import tempfile
import unittest
from pathlib import Path

from hstar_runtime.credentials import (
    CredentialStore,
    DpapiSecretProtector,
    PlaintextEnvCredentialStore,
    create_credential_store,
    migrate_legacy_env,
    migrate_legacy_env_sources,
)


class XorProtector:
    def __init__(self, key: int = 0xA5):
        self.key = key

    def protect(self, payload: bytes) -> bytes:
        return bytes(value ^ self.key for value in payload)

    def unprotect(self, payload: bytes) -> bytes:
        return bytes(value ^ self.key for value in payload)


class FailingProtector:
    def protect(self, payload: bytes) -> bytes:
        raise OSError("encryption failed")

    def unprotect(self, payload: bytes) -> bytes:
        raise OSError("decryption failed")


class CredentialStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store_path = self.root / "secrets" / "credentials.dpapi"

    def tearDown(self):
        self.temporary.cleanup()

    def test_round_trip_never_writes_plaintext_secret(self):
        store = CredentialStore(self.store_path, XorProtector())

        store.save({"COMFLY_API_KEY": "plain-test-secret"})

        self.assertEqual(
            store.load(),
            {"COMFLY_API_KEY": "plain-test-secret"},
        )
        self.assertNotIn(b"plain-test-secret", self.store_path.read_bytes())

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI is required")
    def test_windows_dpapi_round_trip_uses_current_user_scope(self):
        store = CredentialStore(self.store_path, DpapiSecretProtector())

        store.save({"DPAPI_TEST_KEY": "windows-current-user-secret"})

        self.assertEqual(
            store.load(),
            {"DPAPI_TEST_KEY": "windows-current-user-secret"},
        )
        self.assertNotIn(
            b"windows-current-user-secret",
            self.store_path.read_bytes(),
        )

    def test_update_preserves_unrelated_credentials(self):
        store = CredentialStore(self.store_path, XorProtector())
        store.save({"FIRST_KEY": "first", "SECOND_KEY": "second"})

        updated = store.update({"FIRST_KEY": "changed"})

        self.assertEqual(
            updated,
            {"FIRST_KEY": "changed", "SECOND_KEY": "second"},
        )
        self.assertEqual(store.load(), updated)

    def test_legacy_env_is_backed_up_verified_and_removed(self):
        source = self.root / "program" / "API" / ".env"
        source.parent.mkdir(parents=True)
        source_payload = b'# provider settings\nFIRST_KEY="first value"\nSECOND_KEY=second\n'
        source.write_bytes(source_payload)
        backup_dir = self.root / "data" / "backups" / "api"
        store = CredentialStore(self.store_path, XorProtector())

        imported = migrate_legacy_env(source, store, backup_dir)

        self.assertTrue(imported)
        self.assertEqual(
            store.load(),
            {"FIRST_KEY": "first value", "SECOND_KEY": "second"},
        )
        self.assertFalse(source.exists())
        backups = list(backup_dir.glob("*.bak"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), source_payload)

    def test_legacy_env_is_not_imported_when_store_has_values(self):
        source = self.root / "program" / "API" / ".env"
        source.parent.mkdir(parents=True)
        source.write_text("FIRST_KEY=legacy\n", encoding="utf-8")
        store = CredentialStore(self.store_path, XorProtector())
        store.save({"FIRST_KEY": "current"})

        imported = migrate_legacy_env(
            source,
            store,
            self.root / "data" / "backups" / "api",
        )

        self.assertFalse(imported)
        self.assertEqual(store.load(), {"FIRST_KEY": "current"})
        self.assertTrue(source.exists())

    def test_failed_encryption_leaves_legacy_source_untouched(self):
        source = self.root / "program" / "API" / ".env"
        source.parent.mkdir(parents=True)
        source.write_text("FIRST_KEY=legacy\n", encoding="utf-8")
        store = CredentialStore(self.store_path, FailingProtector())

        with self.assertRaisesRegex(OSError, "encryption failed"):
            migrate_legacy_env(
                source,
                store,
                self.root / "data" / "backups" / "api",
            )

        self.assertEqual(source.read_text(encoding="utf-8"), "FIRST_KEY=legacy\n")
        self.assertFalse(self.store_path.exists())

    def test_multiple_legacy_sources_are_merged_backed_up_and_removed(self):
        install_source = self.root / "program" / "API" / ".env"
        data_source = self.root / "data" / "secrets" / "api.env"
        install_source.parent.mkdir(parents=True)
        data_source.parent.mkdir(parents=True)
        install_source.write_text(
            "SHARED_KEY=install-value\nINSTALL_ONLY=install\n",
            encoding="utf-8",
        )
        data_source.write_text(
            "SHARED_KEY=data-value\nDATA_ONLY=data\n",
            encoding="utf-8",
        )
        backup_dir = self.root / "data" / "backups" / "api"
        store = CredentialStore(self.store_path, XorProtector())

        imported = migrate_legacy_env_sources(
            [install_source, data_source],
            store,
            backup_dir,
        )

        self.assertTrue(imported)
        self.assertEqual(
            store.load(),
            {
                "SHARED_KEY": "data-value",
                "INSTALL_ONLY": "install",
                "DATA_ONLY": "data",
            },
        )
        self.assertFalse(install_source.exists())
        self.assertFalse(data_source.exists())
        self.assertEqual(len(list(backup_dir.glob("*.bak"))), 2)

    def test_empty_legacy_env_does_not_create_store_or_backup(self):
        source = self.root / "program" / "API" / ".env"
        source.parent.mkdir(parents=True)
        source.write_text("# no values\n\n", encoding="utf-8")
        backup_dir = self.root / "data" / "backups" / "api"
        store = CredentialStore(self.store_path, XorProtector())

        imported = migrate_legacy_env(source, store, backup_dir)

        self.assertFalse(imported)
        self.assertFalse(self.store_path.exists())
        self.assertTrue(source.exists())
        self.assertFalse(backup_dir.exists())

    def test_packaged_non_windows_runtime_cannot_fall_back_to_plaintext(self):
        windows_store = create_credential_store(
            self.store_path,
            edition="windows11",
            platform_name="nt",
            protector=XorProtector(),
        )
        engineering_store = create_credential_store(
            self.store_path,
            edition="development",
            platform_name="posix",
            plaintext_path=self.root / "secrets" / "api.env",
        )
        test_store = create_credential_store(
            self.store_path,
            edition="test-storage-api",
            platform_name="posix",
            plaintext_path=self.root / "secrets" / "test-api.env",
        )

        self.assertIsInstance(windows_store, CredentialStore)
        self.assertIsInstance(engineering_store, PlaintextEnvCredentialStore)
        self.assertIsInstance(test_store, PlaintextEnvCredentialStore)
        with self.assertRaisesRegex(RuntimeError, "DPAPI"):
            create_credential_store(
                self.store_path,
                edition="windows11",
                platform_name="posix",
                plaintext_path=self.root / "secrets" / "api.env",
            )


if __name__ == "__main__":
    unittest.main()
