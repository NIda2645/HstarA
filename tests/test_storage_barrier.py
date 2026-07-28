import asyncio
import threading
import time
import unittest

from hstar_runtime.storage_barrier import StorageMutationBarrier, StorageMutationBlocked


class StorageMutationBarrierTests(unittest.IsolatedAsyncioTestCase):
    async def test_switch_waits_for_in_flight_mutation(self):
        barrier = StorageMutationBarrier()
        mutation_entered = threading.Event()
        release_mutation = threading.Event()
        switch_entered = threading.Event()

        def mutate():
            with barrier.mutation():
                mutation_entered.set()
                release_mutation.wait(timeout=5)

        def switch():
            with barrier.switch_to_read_only():
                switch_entered.set()

        mutation_thread = threading.Thread(target=mutate)
        switch_thread = threading.Thread(target=switch)
        mutation_thread.start()
        self.assertTrue(await asyncio.to_thread(mutation_entered.wait, 5))
        switch_thread.start()
        await asyncio.sleep(0.05)
        self.assertFalse(switch_entered.is_set())

        release_mutation.set()
        self.assertTrue(await asyncio.to_thread(switch_entered.wait, 5))
        mutation_thread.join(timeout=5)
        switch_thread.join(timeout=5)

    async def test_switch_waits_for_tracked_background_task(self):
        barrier = StorageMutationBarrier()
        release_task = asyncio.Event()
        task_started = asyncio.Event()

        async def persistence_task():
            task_started.set()
            await release_task.wait()

        task = barrier.create_task(persistence_task())
        await asyncio.wait_for(task_started.wait(), timeout=1)
        switch_entered = threading.Event()

        def switch():
            with barrier.switch_to_read_only():
                switch_entered.set()

        switch_thread = threading.Thread(target=switch)
        switch_thread.start()
        await asyncio.sleep(0.05)
        self.assertFalse(switch_entered.is_set())

        release_task.set()
        await task
        self.assertTrue(await asyncio.to_thread(switch_entered.wait, 5))
        switch_thread.join(timeout=5)

    async def test_admitted_background_task_can_spawn_final_writer_during_switch(self):
        barrier = StorageMutationBarrier()
        parent_started = asyncio.Event()
        release_parent = asyncio.Event()
        child_finished = asyncio.Event()
        switch_entered = threading.Event()

        async def child_writer():
            await asyncio.sleep(0)
            child_finished.set()

        async def admitted_parent():
            parent_started.set()
            await release_parent.wait()
            await barrier.create_task(child_writer())

        parent = barrier.create_task(admitted_parent())
        await asyncio.wait_for(parent_started.wait(), timeout=1)

        def switch():
            with barrier.switch_to_read_only():
                switch_entered.set()

        switch_thread = threading.Thread(target=switch)
        switch_thread.start()
        for _ in range(100):
            try:
                with barrier.mutation():
                    pass
            except StorageMutationBlocked as error:
                self.assertEqual(error.reason, "switching")
                break
            await asyncio.sleep(0.01)
        else:
            self.fail("storage switch did not start")

        release_parent.set()
        await parent
        await asyncio.wait_for(child_finished.wait(), timeout=1)
        self.assertTrue(await asyncio.to_thread(switch_entered.wait, 5))
        switch_thread.join(timeout=5)

    async def test_admitted_mutation_can_spawn_background_writer_during_switch(self):
        barrier = StorageMutationBarrier()
        mutation_started = asyncio.Event()
        release_mutation = asyncio.Event()
        child_finished = asyncio.Event()
        switch_entered = threading.Event()

        async def child_writer():
            await asyncio.sleep(0)
            child_finished.set()

        async def admitted_request():
            with barrier.mutation():
                mutation_started.set()
                await release_mutation.wait()
                await barrier.create_task(child_writer())

        request = asyncio.create_task(admitted_request())
        await asyncio.wait_for(mutation_started.wait(), timeout=1)

        def switch():
            with barrier.switch_to_read_only():
                switch_entered.set()

        switch_thread = threading.Thread(target=switch)
        switch_thread.start()
        await asyncio.sleep(0.05)
        self.assertFalse(switch_entered.is_set())

        release_mutation.set()
        await request
        await asyncio.wait_for(child_finished.wait(), timeout=1)
        self.assertTrue(await asyncio.to_thread(switch_entered.wait, 5))
        switch_thread.join(timeout=5)

    async def test_successful_switch_keeps_process_read_only(self):
        barrier = StorageMutationBarrier()
        with barrier.switch_to_read_only():
            pass

        with self.assertRaises(StorageMutationBlocked):
            with barrier.mutation():
                pass

        coroutine = asyncio.sleep(0)
        try:
            with self.assertRaises(StorageMutationBlocked):
                barrier.create_task(coroutine)
        finally:
            coroutine.close()

    async def test_failed_switch_reopens_mutations(self):
        barrier = StorageMutationBarrier()
        with self.assertRaisesRegex(RuntimeError, "commit failed"):
            with barrier.switch_to_read_only():
                raise RuntimeError("commit failed")

        with barrier.mutation():
            pass


if __name__ == "__main__":
    unittest.main()
