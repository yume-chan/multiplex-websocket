import { Duplex } from 'stream';

import { MultiplexWebSocketDispatcher, MultiplexWebSocketOpcode } from './multiplex-websocket-dispatcher';

export default class MultiplexWebSocketChannel extends Duplex {
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
        }
        catch (e) {
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
