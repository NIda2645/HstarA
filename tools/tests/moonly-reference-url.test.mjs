import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const script = String.raw`
import asyncio
import main

calls = []

async def fake_upload(ref_url, service="auto"):
    calls.append((ref_url, service))
    return {"url": "https://public.example/ref-image.png", "source": ref_url, "service": "test"}

main.upload_local_media_to_cloud = fake_upload

async def run():
    local = await main.moonly_reference_url({"url": "/assets/input/ref.png", "name": "ref.png"})
    remote = await main.moonly_reference_url({"url": "https://example.com/already-public.png"})
    print(local)
    print(remote)
    print(calls)

asyncio.run(run())
`;

const raw = execFileSync('py', ['-3', '-X', 'utf8', '-c', script], { encoding: 'utf8' });
const lines = raw.trim().split(/\r?\n/);

assert.equal(lines[0], 'https://public.example/ref-image.png', 'MoonlyAI local image references must be converted to public URLs');
assert.equal(lines[1], 'https://example.com/already-public.png', 'MoonlyAI should keep existing public image URLs');
assert.match(lines[2], /\/assets\/input\/ref\.png/, 'local reference upload should receive the original canvas URL');

console.log('Moonly reference URL tests passed');
