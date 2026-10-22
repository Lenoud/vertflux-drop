// 保持 PairDrop 的分块协议；批量读文件，减少浏览器逐块 I/O 和分区等待。
class FileChunker {
    constructor(file, onChunk, onPartitionEnd, onError = () => {}) {
        this._chunkSize = 64000;
        this._readSize = 1024 * 1024;
        this._maxPartitionSize = 4 * 1024 * 1024;
        this._offset = 0;
        this._partitionSize = 0;
        this._file = file;
        this._onChunk = onChunk;
        this._onPartitionEnd = onPartitionEnd;
        this._onError = onError;
        this._failed = false;
        this._reader = new FileReader();
        this._reader.addEventListener('load', event => this._onChunkRead(event.target.result));
        this._reader.addEventListener('error', () => this._fail(this._reader.error));
        this._reader.addEventListener('abort', () => this._fail(new Error('文件读取已中止')));
    }

    nextPartition() {
        if (this._failed) return;
        this._partitionSize = 0;
        this._readChunk();
    }

    _readChunk() {
        const remaining = this._maxPartitionSize - this._partitionSize;
        try {
            this._reader.readAsArrayBuffer(this._file.slice(this._offset, this._offset + Math.min(this._readSize, remaining)));
        } catch (error) { this._fail(error); }
    }

    async _onChunkRead(buffer) {
        if (this._failed) return;
        try {
            for (let start = 0; start < buffer.byteLength; start += this._chunkSize) {
                const chunk = buffer.slice(start, start + this._chunkSize);
                const pending = this._onChunk(chunk);
                if (pending?.then) await pending;
                this._offset += chunk.byteLength;
                this._partitionSize += chunk.byteLength;
            }
            if (this.isFileEnd()) return;
            // 每个分区仍等对端确认；RTC 待发送数据上限为一个 4 MiB 分区。
            if (this._partitionSize >= this._maxPartitionSize) this._onPartitionEnd(this._offset);
            else this._readChunk();
        } catch (error) { this._fail(error); }
    }

    _fail(error) {
        if (this._failed) return;
        this._failed = true;
        this._onError(error);
    }

    repeatPartition() {
        this._offset -= this._partitionSize;
        this.nextPartition();
    }

    isFileEnd() { return this._offset >= this._file.size; }
}
