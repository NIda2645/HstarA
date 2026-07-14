import agPsd from 'ag-psd';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { readPsd, writePsdBuffer } = agPsd;

export function createTextProbePsd(){
  return {
    width: 1024,
    height: 512,
    children: [
      {
        name: '中文文字 - 经典奶茶',
        text: {
          text: '经典奶茶',
          transform: [1, 0, 0, 1, 120, 180],
          style: {
            font: {name:'MicrosoftYaHei'},
            fontSize: 72,
            fillColor: {r:31, g:41, b:55},
          },
          paragraphStyle: {justification:'left'},
        },
      },
      {
        name: 'English Text - Classic Milk Tea',
        text: {
          text: 'Classic Milk Tea',
          transform: [1, 0, 0, 1, 120, 330],
          style: {
            font: {name:'ArialMT'},
            fontSize: 58,
            fillColor: {r:37, g:99, b:235},
          },
          paragraphStyle: {justification:'left'},
        },
      },
    ],
  };
}

function assertEqual(actual, expected, label){
  if(actual !== expected){
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function assertArrayEqual(actual, expected, label){
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), label);
}

export function verifyTextProbeRoundTrip(buffer){
  const parsed = readPsd(buffer, {
    skipLayerImageData: true,
    skipCompositeImageData: true,
    skipThumbnail: true,
  });
  assertEqual(parsed.width, 1024, 'PSD width');
  assertEqual(parsed.height, 512, 'PSD height');
  assertEqual(parsed.children?.length, 2, 'PSD layer count');
  assertEqual(parsed.children[0]?.text?.text, '经典奶茶', 'Chinese text');
  assertEqual(parsed.children[0]?.text?.style?.font?.name, 'MicrosoftYaHei', 'Chinese font');
  assertArrayEqual(parsed.children[0]?.text?.transform, [1, 0, 0, 1, 120, 180], 'Chinese transform');
  assertEqual(parsed.children[1]?.text?.text, 'Classic Milk Tea', 'English text');
  assertEqual(parsed.children[1]?.text?.style?.font?.name, 'ArialMT', 'English font');
  assertArrayEqual(parsed.children[1]?.text?.transform, [1, 0, 0, 1, 120, 330], 'English transform');
  return parsed;
}

export async function writeTextProbe(outputPath){
  const psd = createTextProbePsd();
  const buffer = writePsdBuffer(psd, {
    invalidateTextLayers: true,
    noBackground: true,
  });
  verifyTextProbeRoundTrip(buffer);
  await mkdir(dirname(outputPath), {recursive:true});
  await writeFile(outputPath, buffer);
  return {outputPath, bytes:buffer.byteLength};
}

const currentPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if(currentPath === invokedPath){
  const outputPath = resolve(dirname(currentPath), '..', 'tests', 'golden', 'openshop-text-layer-probe.psd');
  const result = await writeTextProbe(outputPath);
  console.log(`PSD_FILE=${result.outputPath}`);
  console.log(`PSD_BYTES=${result.bytes}`);
  console.log('PSD_STRUCTURE_PASS');
}
