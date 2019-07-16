import { EventEmitter } from 'events';
import { Duplex } from 'stream';

import { PromiseResolver } from "@yume-chan/async-operation-manager";
import WebSocket from '@yume-chan/fallback-websocket';

function isErrorEvent(e: Event): e is ErrorEvent {
    return 'error' in e;
}

export function connectWebSocket(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        function handleOpen() {
            socket.removeEventListener('open', handleOpen);
            socket.removeEventListener('error', handleError);

            resolve(socket);
        }

        function handleError(e: Event) {
            socket.removeEventListener('open', handleOpen);
            socket.removeEventListener('error', handleError);

            // ws give us an ErrorEvent with error object
            // but browser doesn't give any detail about the error
            if (isErrorEvent(e)) {
                reject(e.error);
            } else {
                reject(new Error('the WebSocket connection cannot be established'));
            }
        }

        const socket = new WebSocket(url);

        socket.addEventListener("open", handleOpen);
        socket.addEventListener("error", handleError);
    });
}

export class MultiplexWebSocketChannel extends Duplex {
    private _dispatcher: MultiplexWebSocketDispatcher;

    private _local: boolean;
    public get local(): boolean { return this._local; }

    private _id: number;
    public get id(): number { return this._id; }

    private _localFull: boolean = false;

    public constructor(dispatcher: MultiplexWebSocketDispatcher, local: boolean, id: number) {
        super();

        this._dispatcher = dispatcher;
        this._local = local;
        this._id = id;
    }

    public _read(): void {
        if (this._localFull) {
            this._dispatcher.sendControlMessage(this._local, this._id, MultiplexWebSocketOpcode.ChannelBufferEmpty);
            this._localFull = false;
        }
    }

    public async _write(chunk: Buffer, encoding: string, callback: (e?: Error) => void): Promise<void> {
        try {
            await this._dispatcher.send(this._local, this._id, chunk);
            callback();
        } catch (e) {
            callback(e);
        }
    }

    public push(chunk: Buffer): boolean {
        const result = super.push(chunk);
        if (!result && !this._localFull) {
            this._dispatcher.sendControlMessage(this._local, this._id, MultiplexWebSocketOpcode.ChannelBufferFull);
            this._localFull = true;
        }
        return result;
    }

    public _final(callback: () => void): void {
        this._dispatcher.sendControlMessage(this._local, this._id, MultiplexWebSocketOpcode.CloseChannel);
        callback();
        this.destroy();
    }

    public _destroy(error: Error | null, callback: (error: Error | null) => void): void {
        callback(error);
    }
}

enum MultiplexWebSocketOpcode {
    CreateChannel,
    CloseChannel,
    Data,
    ChannelBufferFull,
    ChannelBufferEmpty,
}

class MultiplexWebSocketMessage {
    public static parse(buffer: ArrayBuffer): MultiplexWebSocketMessage {
        const view = new DataView(buffer);

        const opcode: MultiplexWebSocketOpcode = view.getUint8(0);
        const local: boolean = view.getUint8(1) === 0;
        const id: number = view.getUint32(2, false);
        const data: ArrayBuffer = buffer.slice(6);

        return new MultiplexWebSocketMessage(opcode, local, id, data);
    }

    private _opcode: MultiplexWebSocketOpcode;
    public get opcode(): MultiplexWebSocketOpcode { return this._opcode; }

    private _local: boolean;
    public get local(): boolean { return this._local; }

    private _id: number;
    public get id(): number { return this._id; }

    private _data: ArrayBuffer | undefined;
    public get data(): ArrayBuffer | undefined { return this._data; }

    public constructor(opcode: MultiplexWebSocketOpcode, local: boolean, id: number, data?: ArrayBuffer) {
        this._opcode = opcode;
        this._local = local;
        this._id = id;
        this._data = data;
    }

    public toBuffer(): ArrayBuffer {
        const result = Buffer.alloc(6 + (this._data ? this._data.byteLength : 0));
        result.writeUInt8(this._opcode, 0);
        result.writeUInt8(this._local ? 0 : 1, 1);
        result.writeUInt32BE(this._id, 2);
        if (this._data) {
            result.set(Buffer.from(this._data), 6);
        }
        return result;
    }
}

interface MultiplexWebSocketSendTask {
    resolver: PromiseResolver<void>;

    data: Buffer;
}

class MultiplexWebSocketSendQueue {
    private _local: boolean;
    public get local(): boolean { return this._local; }

    private _id: number;
    public get id(): number { return this._id; }

    private _queue: MultiplexWebSocketSendTask[] = [];
    public get length(): number { return this._queue.length; }

    public remoteFull: boolean = false;

    public lastSendTime: number = 0;

    public constructor(local: boolean, id: number) {
        this._local = local;
        this._id = id;
    }

    public enqueue(data: Buffer): Promise<void> {
        const resolver = new PromiseResolver<void>();
        this._queue.push({ resolver, data });
        return resolver.promise;
    }

    public dequeue(): MultiplexWebSocketSendTask | undefined {
        return this._queue.shift();
    }
}

const resolvedPromise = Promise.resolve();

function waitWebSocketBufferAmountLow(socket: WebSocket): Promise<void> {
    const bufferLowAmount = 1024 * 1024;

    if (socket.bufferedAmount < bufferLowAmount) {
        return resolvedPromise;
    }

    const resolver = new PromiseResolver<void>();
    const intervalId = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) {
            resolver.reject(new Error(`readyState is not 'open'`));
        }

        if (socket.bufferedAmount < bufferLowAmount) {
            resolver.resolve();
            clearInterval(intervalId);
        }
    }, 500);
    return resolver.promise;
}

class MultiplexWebSocketDispatcher {
    private _socket: WebSocket;

    private _queues: MultiplexWebSocketSendQueue[] = [];

    public constructor(owner: WebSocket) {
        this._socket = owner;
    }

    private _controlQueue: MultiplexWebSocketMessage[] = [];

    private _processingControlQueue = false;

    private async processControlQueue() {
        if (this._processingControlQueue) {
            return;
        }

        this._processingControlQueue = true;

        while (this._controlQueue.length) {
            await waitWebSocketBufferAmountLow(this._socket);
            const message = this._controlQueue.shift()!;
            this._socket.send(message.toBuffer());
        }

        this._processingControlQueue = false;

        this.processQueues();
    }

    public sendControlMessage(local: boolean, id: number, opcode: MultiplexWebSocketOpcode) {
        this._controlQueue.push(new MultiplexWebSocketMessage(opcode, local, id));
        this.processControlQueue();
    }

    private _processingQueues: boolean = false;

    private async processQueues() {
        if (this._processingQueues) {
            return;
        }

        this._processingQueues = true;

        while (true) {
            if (this._processingControlQueue) {
                break;
            }

            const pending = this._queues.filter(x => !x.remoteFull && x.length);

            if (pending.length === 0) {
                break;
            }

            pending.sort((a, b) => a.lastSendTime - b.lastSendTime);
            const candidate = pending[0];

            const task = candidate.dequeue()!;
            try {
                await waitWebSocketBufferAmountLow(this._socket);
                this._socket.send(new MultiplexWebSocketMessage(
                    candidate.lastSendTime === 0 ? MultiplexWebSocketOpcode.CreateChannel : MultiplexWebSocketOpcode.Data,
                    candidate.local,
                    candidate.id,
                    task.data).toBuffer());
                candidate.lastSendTime = Date.now();
                task.resolver.resolve();
            } catch (e) {
                task.resolver.reject(e);
            }
        }

        this._processingQueues = false;
    }

    public addChannel(channel: MultiplexWebSocketChannel): void {
        const queue = new MultiplexWebSocketSendQueue(channel.local, channel.id);
        this._queues.push(queue);
        channel.on('close', () => {
            const index = this._queues.indexOf(queue);
            if (index !== -1) {
                this._queues.splice(index, 1);
            }
        });
    }

    public handleControlMessage(local: boolean, id: number, opcode: MultiplexWebSocketOpcode): void {
        const queue = this._queues.find(x => x.local === local && x.id === id);
        if (queue) {
            queue.remoteFull = opcode === MultiplexWebSocketOpcode.ChannelBufferFull ? true : false;
        }
    }

    public send(local: boolean, id: number, data: Buffer): Promise<void> {
        const queue = this._queues.find(x => x.local === local && x.id === id);
        if (!queue) {
            throw new Error('cannot write after end');
        }

        const result = queue.enqueue(data);
        this.processQueues();
        return result;
    }
}

export default class MultiplexWebSocket {
    public static async connect(url: string): Promise<MultiplexWebSocket> {
        return new MultiplexWebSocket(await connectWebSocket(url));
    }

    private _raw: WebSocket;

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
                        this._emitter.emit('channel', channel, message.data);
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

    public on(type: 'channel', listener: (channel: MultiplexWebSocketChannel, head: ArrayBuffer) => void): this;
    public on(type: 'error', listener: (error: Error) => void): this;
    public on(type: 'close', listener: () => void): this;
    public on(type: string, listener: (...args: any) => void): this {
        this._emitter.on(type, listener);
        return this;
    }

    public off(type: 'channel', listener: (channel: MultiplexWebSocketChannel, head: ArrayBuffer) => void): this;
    public off(type: 'error', listener: (error: Error) => void): this;
    public off(type: 'close', listener: () => void): this;
    public off(type: string, listener: (...args: any) => void): this {
        this._emitter.off(type, listener);
        return this;
    }
}
