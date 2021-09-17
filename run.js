const fs = require('fs');
WebAssembly.instantiate(
  fs.readFileSync(process.argv[2]),
  { 
    platform: {
      now: Date.now
    }
  }
).then(({instance: {exports: wasm}}) => {
  const params = process.argv.slice(3);
  const res = wasm._start(...params);
  console.log(res);
});