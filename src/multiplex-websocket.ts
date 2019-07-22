import { EventEmitter } from 'events';

import { connect as connectWebSocket } from '@yume-chan/fallback-websocket';

import MultiplexWebSocketChannel from './multiplex-websocket-channel';
import { MultiplexWebSocketDispatcher, MultiplexWebSocketMessage, MultiplexWebSocketOpcode } from './multiplex-websocket-dispatcher';

export default class MultiplexWebSocket {
    public static async connect(url: string): Promise<MultiplexWebSocket> {
        return new MultiplexWebSocket(await connectWebSocket(url));
    }

    private _raw: WebSocket;
    public get raw(): WebSocket { return this._raw; }

    private _dispatcher: MultiplexWebSocketDispatcher;

    private _id: number = 0;

    private _emitter: EventEmitter = new EventEmitter();

    private _channels: MultiplexWebSocketChannel[] = [];

    public constructor(raw: WebSocket) {
        this._raw = raw;
        this._raw.binaryType = 'arraybuffer';
        this._raw.addEventListener('message', ({ data }: { data: ArrayBuffer }) => {
            const message = MultiplexWebSocketMessage.parse(data);
            switch (message.opcode) {
                case MultiplexWebSocketOpcode.CreateChannel:
                    {
                        const channel = new MultiplexWebSocketChannel(this._dispatcher, false, message.id);
                        this.initialzeChannel(channel);
                        this._emitter.emit('channel', channel, Buffer.from(message.data!));
                    }
                    break;
                case MultiplexWebSocketOpcode.Data:
                    {
                        const channel = this._channels.find(x => x.local !== message.local && x.id === message.id);
                        if (channel) {
                            channel.push(Buffer.from(message.data!));
                        }
                    }
                    break;
                case MultiplexWebSocketOpcode.CloseChannel:
                    {
                        const channel = this._channels.find(x => x.local !== message.local && x.id === message.id);
                        if (channel) {
                            channel.end();
                        }
                    }
                    break;
                case MultiplexWebSocketOpcode.ChannelBufferFull:
                case MultiplexWebSocketOpcode.ChannelBufferEmpty:
                    this._dispatcher.handleControlMessage(!message.local, message.id, message.opcode);
                    break;
            }
        });
        this._raw.addEventListener('error', () => {
            this._emitter.emit('error', new Error('an error has occurred'));
        });
        this._raw.addEventListener('close', () => {
            for (const channel of this._channels.slice()) {
                channel.end();
            }
            this._emitter.emit('close');
        });

        this._dispatcher = new MultiplexWebSocketDispatcher(this._raw);
    }

    private initialzeChannel(channel: MultiplexWebSocketChannel): void {
        this._dispatcher.addChannel(channel);
        this._channels.push(channel);
        channel.on('close', () => {
            const index = this._channels.indexOf(channel);
            if (index !== -1) {
                this._channels.splice(index, 1);
            }
        });
    }

    public addChannel(): MultiplexWebSocketChannel {
        const channel = new MultiplexWebSocketChannel(this._dispatcher, true, this._id);
        this._id += 1;
        this.initialzeChannel(channel);
        return channel;
    }

    public close() {
        this._raw.close();
    }

    public on(type: 'channel', listener: (channel: MultiplexWebSocketChannel, head: Buffer) => void): this;
    public on(type: 'error', listener: (error: Error) => void): this;
    public on(type: 'close', listener: () => void): this;
    public on(type: string, listener: (...args: any) => void): this {
        this._emitter.on(type, listener);
        return this;
    }

    public off(type: 'channel', listener: (channel: MultiplexWebSocketChannel, head: Buffer) => void): this;
    public off(type: 'error', listener: (error: Error) => void): this;
    public off(type: 'close', listener: () => void): this;
    public off(type: string, listener: (...args: any) => void): this {
        this._emitter.off(type, listener);
        return this;
    }
}
