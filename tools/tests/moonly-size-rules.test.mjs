import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const script = String.raw`
import json
import main
cases = {
    'vip_1k_1_1': main.moonly_validate_size_resolution('1:1', '1K', 'gpt-image-2-vip'),
    'vip_2k_1_1': main.moonly_validate_size_resolution('1:1', '2K', 'gpt-image-2-vip'),
    'vip_1k_3_2': main.moonly_validate_size_resolution('3:2', '1K', 'gpt-image-2-vip'),
    'vip_1k_2_3': main.moonly_validate_size_resolution('2:3', '1K', 'gpt-image-2-vip'),
    'vip_2k_16_9': main.moonly_validate_size_resolution('16:9', '2K', 'gpt-image-2-vip'),
    'vip_4k_16_9': main.moonly_validate_size_resolution('16:9', '4K', 'gpt-image-2-vip'),
    'vip_4k_9_16': main.moonly_validate_size_resolution('9:16', '4K', 'gpt-image-2-vip'),
    'vip_1k_4_3': main.moonly_validate_size_resolution('4:3', '1K', 'gpt-image-2-vip'),
    'vip_2k_2_3': main.moonly_validate_size_resolution('2:3', '2K', 'gpt-image-2-vip'),
    'vip_4k_1_1': main.moonly_validate_size_resolution('1:1', '4K', 'gpt-image-2-vip'),
    'base_4k_1_1': main.moonly_validate_size_resolution('1:1', '4K', 'gpt-image-2'),
    'vip_size_2048_square': main.moonly_request_size_resolution('2048x2048', 'gpt-image-2-vip'),
    'vip_size_3840_wide': main.moonly_request_size_resolution('3840x2160', 'gpt-image-2-vip'),
    'vip_allowed_ratios_2k': sorted(main.moonly_allowed_ratios_for('gpt-image-2-vip', '2K')),
    'fast_allowed_ratios_2k': sorted(main.moonly_allowed_ratios_for('gpt-image-2-fast', '2K')),
    'fast_2k_1_1': main.moonly_validate_size_resolution('1:1', '2K', 'gpt-image-2-fast'),
    'fast_2k_16_9': main.moonly_validate_size_resolution('16:9', '2K', 'gpt-image-2-fast'),
    'base_4k_1_1_combo': main.moonly_validate_size_resolution('1:1', '4K', 'gpt-image-2'),
    'base_4k_16_9_combo': main.moonly_validate_size_resolution('16:9', '4K', 'gpt-image-2'),
    'official_4k_1_1_combo': main.moonly_validate_size_resolution('1:1', '4K', 'gpt-image-2-official'),
}
print(json.dumps(cases))
`;

const raw = execFileSync('py', ['-3', '-X', 'utf8', '-c', script], { encoding: 'utf8' });
const result = JSON.parse(raw.trim().split(/\r?\n/).at(-1));

assert.equal(result.vip_1k_1_1, true, 'VIP should allow 1K 1:1');
assert.equal(result.vip_2k_1_1, true, 'VIP should allow 2K 1:1');
assert.equal(result.vip_1k_3_2, true, 'VIP should allow 1K 3:2');
assert.equal(result.vip_1k_2_3, true, 'VIP should allow 1K 2:3');
assert.equal(result.vip_2k_16_9, true, 'VIP should allow 2K 16:9');
assert.equal(result.vip_4k_16_9, true, 'VIP should allow 4K 16:9');
assert.equal(result.vip_4k_9_16, true, 'VIP should allow 4K 9:16');
assert.equal(result.vip_1k_4_3, false, 'VIP should disable unlisted 1K 4:3');
assert.equal(result.vip_2k_2_3, false, 'VIP should disable unlisted 2K 2:3');
assert.equal(result.vip_4k_1_1, false, 'VIP should disable unlisted 4K 1:1');
assert.equal(result.base_4k_1_1, false, 'base should reject unlisted 4K 1:1 according to the Moonly ratio table');
assert.deepEqual(result.vip_size_2048_square, ['1:1', '2K'], 'VIP 2048 square should resolve to 2K 1:1');
assert.deepEqual(result.vip_size_3840_wide, ['16:9', '4K'], 'VIP 3840x2160 should resolve to 4K 16:9');
assert.deepEqual(new Set(result.vip_allowed_ratios_2k), new Set(['1:1', '16:9']), 'VIP 2K should expose only the documented 1:1 and 16:9 ratios');
assert.deepEqual(result.fast_allowed_ratios_2k, ['16:9'], 'fast 2K should keep its own documented ratio set');
assert.equal(result.fast_2k_1_1, false, 'fast should reject unlisted 2K 1:1');
assert.equal(result.fast_2k_16_9, true, 'fast should allow listed 2K 16:9');
assert.equal(result.base_4k_1_1_combo, false, 'base should reject unlisted 4K 1:1');
assert.equal(result.base_4k_16_9_combo, true, 'base should allow listed 4K 16:9');
assert.equal(result.official_4k_1_1_combo, false, 'official should reject unlisted 4K 1:1');

const canvas = fs.readFileSync('static/js/canvas.js', 'utf8');
const smart = fs.readFileSync('static/js/smart-canvas.js', 'utf8');
assert.match(canvas, /MOONLY_VIP_ALLOWED_COMBOS/, 'normal canvas should define a VIP whitelist');
assert.doesNotMatch(canvas, /gpt-image-2-fast' \|\| name === 'gpt-image-2-vip'\) return 'fast_vip'/, 'normal canvas must not route VIP through the fast ratio group');
assert.match(canvas, /function moonlySizeComboAllowed[\s\S]*moonlyAllowedRatiosFor\(model, resolution\)\.has\(ratio\)/, 'normal canvas should apply the four-model Moonly table to options');
assert.doesNotMatch(canvas, /if\(modelName !== 'gpt-image-2-vip'\) return true;/, 'normal canvas must not bypass non-VIP Moonly model restrictions');
assert.match(canvas, /moonlyAllowedRatiosFor\(model, resolution\)\.has\(ratio\)/, 'normal canvas should use the four-model Moonly ratio table for disabled states');
assert.doesNotMatch(canvas, /String\(model \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== 'gpt-image-2-vip'/, 'normal canvas resolution options must not use a VIP-only bypass');
assert.match(canvas, /option\.disabled = !allowed/, 'normal canvas should disable unlisted VIP combinations');
assert.match(canvas, /ratioSelect\.options\]\.some\(ratio => moonlySizeComboAllowed\(providerId, model, ratio\.value, option\.value\)\)/, 'normal canvas resolution options should remain reachable when any ratio exists for that resolution');
assert.match(canvas, /normalizeMoonlyVipCombo\(node, node\.apiProvider, node\.model\)/, 'normal canvas should normalize invalid VIP combinations after resolution changes');
assert.doesNotMatch(smart, /MOONLY_VIP_ALLOWED_COMBOS/, 'pure smart canvas baseline should not contain the old fused Moonly VIP table');

console.log('MoonlyAI VIP size option tests passed');
