import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class ImapClient {
    constructor({ host, port = 993, username, password, useTls = true, cancellable, logger }) {
        this._host = host;
        this._port = port;
        this._username = username;
        this._password = password;
        this._useTls = useTls;
        this._cancellable = cancellable;
        this._logger = logger;
        this._connection = null;
        this._input = null;
        this._output = null;
        this._commandId = 0;
        this._buffer = '';
    }

    async connect() {
        const client = new Gio.SocketClient();

        if (this._useTls) {
            client.set_tls(true);
        }

        this._connection = await client.connect_to_host_async(
            `${this._host}:${this._port}`,
            this._port,
            this._cancellable
        );

        this._input = this._connection.get_input_stream();
        this._output = this._connection.get_output_stream();

        // Read greeting
        await this._readResponse();

        // Login
        await this._login();
    }

    async _login() {
        const response = await this._sendCommand('LOGIN', `"${this._username}" "${this._password}"`);
        if (!response.includes('OK')) {
            throw new Error('IMAP login failed');
        }
    }

    async selectMailbox(mailbox = 'INBOX') {
        const response = await this._sendCommand('SELECT', `"${mailbox}"`);
        if (!response.includes('OK')) {
            throw new Error(`Failed to select mailbox: ${mailbox}`);
        }
    }

    async searchUnread() {
        const response = await this._sendCommand('SEARCH', 'UNSEEN');
        const match = response.match(/\* SEARCH (.+)/);

        if (!match || !match[1].trim()) {
            return [];
        }

        return match[1].trim().split(' ').filter(id => id);
    }

    async fetchMessages(messageIds) {
        if (messageIds.length === 0) {
            return [];
        }

        const idRange = messageIds.join(',');
        const response = await this._sendCommand(
            'FETCH',
            `${idRange} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID)])`
        );

        return this._parseMessages(response);
    }

    async logout() {
        try {
            await this._sendCommand('LOGOUT');
        } catch (err) {
            this._logger?.log(`IMAP logout error: ${err.message}`);
        } finally {
            this._connection?.close(null);
            this._connection = null;
        }
    }

    async _sendCommand(command, args = '') {
        this._commandId++;
        const tag = `A${this._commandId.toString().padStart(4, '0')}`;
        const cmd = args ? `${tag} ${command} ${args}\r\n` : `${tag} ${command}\r\n`;

        const bytes = new GLib.Bytes(new TextEncoder().encode(cmd));
        await this._output.write_bytes_async(
            bytes,
            GLib.PRIORITY_DEFAULT,
            this._cancellable
        );

        return await this._readResponse(tag);
    }

    async _readResponse(tag = null) {
        let response = '';

        while (true) {
            const bytes = await this._input.read_bytes_async(
                4096,
                GLib.PRIORITY_DEFAULT,
                this._cancellable
            );

            if (bytes.get_size() === 0) {
                break;
            }

            const chunk = new TextDecoder('utf-8').decode(bytes.get_data());
            this._buffer += chunk;
            response += chunk;

            // Check if we have a complete response
            if (tag) {
                if (this._buffer.includes(`${tag} OK`) || this._buffer.includes(`${tag} NO`) || this._buffer.includes(`${tag} BAD`)) {
                    const result = this._buffer;
                    this._buffer = '';
                    return result;
                }
            } else {
                // For untagged responses (like greeting)
                if (this._buffer.includes('\r\n')) {
                    const result = this._buffer;
                    this._buffer = '';
                    return result;
                }
            }

            // Add small delay to allow more data to arrive
            await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            }));
        }

        return response;
    }

    _parseMessages(response) {
        const messages = [];
        const lines = response.split('\n');
        let currentMessage = null;
        let currentHeaders = '';

        for (const line of lines) {
            const fetchMatch = line.match(/\* (\d+) FETCH/);
            if (fetchMatch) {
                if (currentMessage && currentHeaders) {
                    messages.push(this._parseHeaders(currentMessage, currentHeaders));
                }
                currentMessage = fetchMatch[1];
                currentHeaders = '';
            } else if (currentMessage) {
                currentHeaders += line + '\n';
            }
        }

        if (currentMessage && currentHeaders) {
            messages.push(this._parseHeaders(currentMessage, currentHeaders));
        }

        return messages;
    }

    _parseHeaders(seqNum, headers) {
        const fromMatch = headers.match(/From: (.+)/i);
        const subjectMatch = headers.match(/Subject: (.+)/i);
        const messageIdMatch = headers.match(/Message-ID: <(.+?)>/i);

        return {
            id: messageIdMatch ? messageIdMatch[1] : `msg_${seqNum}`,
            subject: subjectMatch ? subjectMatch[1].trim() : '(No subject)',
            from: fromMatch ? fromMatch[1].trim() : '(Unknown sender)',
            link: null,
        };
    }
}
