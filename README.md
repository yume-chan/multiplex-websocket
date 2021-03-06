# Multiplex WebSocket

[![travis-ci](https://travis-ci.org/yume-chan/multiplex-websocket.svg?branch=master)](https://travis-ci.org/yume-chan/multiplex-websocket)
[![Greenkeeper badge](https://badges.greenkeeper.io/yume-chan/multiplex-websocket.svg)](https://greenkeeper.io/)

A simple multiplex protocol for WebSocket

- [Multiplex WebSocket](#multiplex-websocket)
  - [Install](#install)
    - [Node.js](#nodejs)
    - [Browsers](#browsers)
  - [API](#api)
  - [Development](#development)
    - [Install dependencies](#install-dependencies)
    - [Testing](#testing)
    - [Coverage](#coverage)
  - [License](#license)

## Install

``` shell
npm install @yume-chan/multiplex-websocket
```

### Node.js

`ws` is a peer dependency, you need to install it separately for Node.js.

``` shell
npm install ws
```

### Browsers

This package uses Node.js built-in modules (`Buffer`, `event` and `stream`), so it needs polyfills to run in browsers.

Webpack should work, although not tested.

## API

``` ts
export default class MultiplexWebSocket {
    static connect(url: string): Promise<MultiplexWebSocket>;

    constructor(raw: WebSocket);

    addChannel(): MultiplexWebSocketChannel;
    close(): void;

    on(type: 'channel', listener: (channel: MultiplexWebSocketChannel, head: Buffer) => void): this;
    on(type: 'error', listener: (error: Error) => void): this;
    on(type: 'close', listener: () => void): this;

    off(type: 'channel', listener: (channel: MultiplexWebSocketChannel, head: Buffer) => void): this;
    off(type: 'error', listener: (error: Error) => void): this;
    off(type: 'close', listener: () => void): this;
}

export class MultiplexWebSocketChannel extends Duplex { }
```

`MultiplexWebSocketChannel` is a duplex stream so you can use common stream operations (`.read()`, `.write()`, `.pipe()`, `.on('data')`) on it.

## Development

This project uses [pnpm](https://pnpm.js.org/) ([GitHub](https://github.com/pnpm/pnpm)) to manage dependency packages.

### Install dependencies

``` shell
pnpm i
```

You may also use `npm`, but the lockfile may become out of sync.

### Testing

``` shell
npm test
```

### Coverage

``` shell
npm run coverage
```

## License

MIT
