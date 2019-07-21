import { randomBytes } from 'crypto';

import WebSocket, { Server as WebSocketServer } from 'ws';

import MultiplexWebSocket, { MultiplexWebSocketChannel } from '../src';

interface StepInfo {
    connection: MultiplexWebSocket;

    client: MultiplexWebSocketChannel;

    server: MultiplexWebSocketChannel;

    dataOrigin: 'client' | 'server';

    data: ArrayBuffer;
}

type Step = (info: StepInfo) => void;

function runSteps(
    done: () => void,
    initalData: ArrayBuffer,
    ...steps: Step[]
): void {
    const port = 9031;
    const server = new WebSocketServer({ port });

    let connection: MultiplexWebSocket;
    let client: MultiplexWebSocketChannel;
    let remote: MultiplexWebSocketChannel;

    let index = 0;
    function callStep(dataOrigin: 'client' | 'server', data: Buffer) {
        steps[index]({ connection, client, server: remote, dataOrigin, data });
        index += 1;
        if (index === steps.length) {
            remote.end();
        }
    }

    server.on('connection', (raw) => {
        connection = new MultiplexWebSocket(raw as any);
        connection.on('channel', (channel, head) => {
            remote = channel;
            callStep('server', head);

            channel.on('data', (data) => {
                callStep('server', data);
            });
        });
    });

    server.on('listening', async () => {
        const connection = await MultiplexWebSocket.connect(`ws://localhost:${port}`);

        client = connection.addChannel();
        client.on('data', (data) => {
            callStep('client', data);
        });
        client.on('close', () => {
            connection.close();
            server.close();
            done();
        });
        client.write(Buffer.from(initalData));
    });
}

describe('MultiplexWebSocket', () => {
    it('should have raw property', (done) => {
        const data = randomBytes(20);

        runSteps(done, data, (info) => {
            expect(info.connection).toHaveProperty('raw', expect.any(WebSocket));
        });
    });

    it('should connect', (done) => {
        const data = randomBytes(20);

        runSteps(done, data, (info) => {
            expect(info.dataOrigin).toBe('server');
            expect(info.data).toEqual(data);
        });
    });
});

describe('MultiplexWebSocketChannel', () => {
    it('should send data', (done) => {
        let data = randomBytes(20);

        runSteps(done, data, (info) => {
            data = randomBytes(20);
            info.client.write(data);
        }, (info) => {
            expect(info.dataOrigin).toBe('server');
            expect(info.data).toEqual(data);
        });
    });

    it('should be able to reply', (done) => {
        let data = randomBytes(20);

        runSteps(done, data, (info) => {
            data = randomBytes(20);
            info.server.write(data);
        }, (info) => {
            expect(info.dataOrigin).toBe('client');
            expect(info.data).toEqual(data);
        });
    });
});
