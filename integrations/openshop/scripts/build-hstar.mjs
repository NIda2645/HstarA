import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const integrationRoot = resolve(scriptDir, '..');
const projectRoot = resolve(integrationRoot, '..', '..');
const staticRoot = resolve(projectRoot, 'static');
const destination = resolve(staticRoot, 'openshop');

if(dirname(destination) !== staticRoot){
  throw new Error(`Unsafe OpenShop build destination: ${destination}`);
}

const runtimeFiles = [
  'index.html',
  'icon.png',
  'LICENSE',
  'host/openshop-protocol.js',
  'host/openshop-project-adapter.js',
  'host/openshop-host-runtime.js',
].sort();

await rm(destination, {recursive:true, force:true});

for(const file of runtimeFiles){
  const source = resolve(integrationRoot, file);
  const target = resolve(destination, file);
  if(!source.startsWith(`${integrationRoot}\\`) && !source.startsWith(`${integrationRoot}/`)){
    throw new Error(`Unsafe OpenShop build source: ${source}`);
  }
  if(!target.startsWith(`${destination}\\`) && !target.startsWith(`${destination}/`)){
    throw new Error(`Unsafe OpenShop build target: ${target}`);
  }
  await mkdir(dirname(target), {recursive:true});
  await copyFile(source, target);
  console.log(relative(projectRoot, target).replaceAll('\\', '/'));
}
