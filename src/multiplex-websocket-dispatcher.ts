import { PromiseResolver } from "@yume-chan/async-operation-manager";
import WebSocket from '@yume-chan/fallback-websocket';

import MultiplexWebSocketChannel from "./multiplex-websocket-channel";

export enum MultiplexWebSocketOpcode {
    CreateChannel,
    CloseChannel,
    Data,
    ChannelBufferFull,
    ChannelBufferEmpty,
}

export class MultiplexWebSocketMessage {
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

export class MultiplexWebSocketDispatcher {
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

                const opcode = candidate.local && candidate.lastSendTime === 0
                    ? MultiplexWebSocketOpcode.CreateChannel
                    : MultiplexWebSocketOpcode.Data;
                this._socket.send(new MultiplexWebSocketMessage(
                    opcode,
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
