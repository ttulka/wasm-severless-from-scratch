const {parentPort, workerData} = require("worker_threads");

const START_FUNCTION = "_start";
const MEMORY_PAGES = 1;
const IMPORT_PLATFORM = { 
  now: Date.now
};

execModule(workerData)
  .then(res => parentPort.postMessage(res));

async function execModule({wasmBuffer, params}) {
  const {instance: {exports: wasm}} = await WebAssembly.instantiate(wasmBuffer, {
    platform: {
      ...IMPORT_PLATFORM, 
      memory: new WebAssembly.Memory({initial: MEMORY_PAGES})
    }});
  try {
    return wasm[START_FUNCTION](...params);
  } catch (err) {
    return err;
  }
}