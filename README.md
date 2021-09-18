# WebAssembly Serverless Computing Platform from Scratch

A serverless computing platform in Node.js based on the concept of Wasm nanoprocesses.

## Build

```sh
$ wat2wasm sum.wat -o sum.wasm
```

## Run

```sh
$ node index.js
server is running on http://localhost:8000
```

## Use

```sh
# register a wasm module:
$ curl http://localhost:8000/register/sum
module 'sum' registered successfully

# execute a registered wasm module:
$ curl http://localhost:8000/exec/sum?5,2
7

# computation stats:
$ curl http://localhost:8000/stats/sum
execution time: 37ms
```

## License

[MIT](https://github.com/ttulka/wasm-severless-from-scratch/blob/main/LICENSE)