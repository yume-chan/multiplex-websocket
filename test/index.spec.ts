import { Server as WebSocketServer } from 'ws';

import MultiplexWebSocket, { MultiplexWebSocketChannel } from '../src';

function runSteps(done: () => void, ...steps: ((connection: MultiplexWebSocketChannel, response: Buffer) => void)[]): void {
    const port = 9031;
    const data = 'hello, world!';
    const server = new WebSocketServer({ port });
    server.on('connection', (raw) => {
        const connection = new MultiplexWebSocket(raw as unknown as WebSocket);
        connection.on('channel', (channel, head) => {
            let index = 0;
            channel.on('data', (response) => {
                steps[index](channel, response);
                index += 1;
                if (index === steps.length) {
                    done();
                }
            });
        });
    });
    server.on('listening', async () => {
        const connection = await MultiplexWebSocket.connect(`ws://localhost:${port}`);
        const channel = connection.addChannel();
        channel.on('close', () => {
            connection.close();
            server.close();
        });
        channel.write(Buffer.from(data, 'utf8'));
    });
}

describe('multiplex websocket', () => {
    it('connect', (done) => {
        const port = 9031;
        const data = 'hello, world!';
        const server = new WebSocketServer({ port });
        server.on('connection', (raw) => {
            const connection = new MultiplexWebSocket(raw as unknown as WebSocket);
            connection.on('channel', (channel, head) => {
                expect(Buffer.from(head).toString('utf8')).toBe(data);
                channel.end();
                done();
            });
        });
        server.on('listening', async () => {
            const connection = await MultiplexWebSocket.connect(`ws://localhost:${port}`);
            const channel = connection.addChannel();
            channel.on('close', () => {
                connection.close();
                server.close();
            });
            channel.write(Buffer.from(data, 'utf8'));
        });
    }, 100000000);
});
