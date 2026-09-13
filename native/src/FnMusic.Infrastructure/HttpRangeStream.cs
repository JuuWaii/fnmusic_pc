using System.Net;
using System.Net.Http.Headers;
using FnMusic.Core;

namespace FnMusic.Infrastructure;

/// <summary>以受控 Range 请求提供可定位流；只缓存一个 256 KiB 块，不将歌曲写入磁盘。</summary>
public sealed class HttpRangeStream : Stream
{
    private const int BlockSize = 256 * 1024;
    private readonly HttpClient client;
    private readonly Uri source;
    private readonly long length;
    private readonly SemaphoreSlim gate = new(1);
    private readonly CancellationTokenSource lifetime = new();
    private byte[] block = [];
    private long blockOffset = -1, position;
    private bool disposed;
    public string ContentType { get; }

    private HttpRangeStream(HttpClient client, Uri source, long length, string contentType)
    { this.client = client; this.source = source; this.length = length; ContentType = contentType; }

    // 接管专用 HttpClient，调用者不得复用它发送其他主机请求。
    public static async Task<HttpRangeStream> OpenAsync(HttpClient client, Uri source, CancellationToken ct)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            using var request = new HttpRequestMessage(HttpMethod.Get, source);
            request.Headers.Range = new RangeHeaderValue(0, 0);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
            CheckResponse(response, 0, 0);
            long size = response.Content.Headers.ContentRange!.Length!.Value;
            string type = response.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";
            if (!type.StartsWith("audio/", StringComparison.OrdinalIgnoreCase) && type != "application/octet-stream")
                throw new MusicApiException(MusicFailure.InvalidResponse);
            return new HttpRangeStream(client, source, size, type);
        }
        catch { client.Dispose(); throw; }
    }

    private static void CheckResponse(HttpResponseMessage response, long from, long to, long? expectedLength = null)
    {
        if (response.StatusCode == HttpStatusCode.Unauthorized) throw new MusicApiException(MusicFailure.Unauthorized);
        if ((int)response.StatusCode is >= 300 and < 400) throw new MusicApiException(MusicFailure.RedirectRejected);
        var range = response.Content.Headers.ContentRange;
        if (response.StatusCode != HttpStatusCode.PartialContent || range?.Unit != "bytes" || range.From != from || range.To != to ||
            range.Length is null || range.Length <= to || (expectedLength is not null && range.Length != expectedLength))
            throw new MusicApiException(MusicFailure.InvalidResponse);
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, lifetime.Token);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        await gate.WaitAsync(timeout.Token).ConfigureAwait(false);
        try
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (buffer.IsEmpty || position >= length) return 0;
            long start = position / BlockSize * BlockSize;
            if (blockOffset != start)
            {
                long end = Math.Min(length - 1, start + BlockSize - 1);
                using var request = new HttpRequestMessage(HttpMethod.Get, source);
                request.Headers.Range = new RangeHeaderValue(start, end);
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
                CheckResponse(response, start, end, length);
                byte[] next = new byte[checked((int)(end - start + 1))];
                using var input = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
                await input.ReadExactlyAsync(next, timeout.Token).ConfigureAwait(false);
                block = next;
                blockOffset = start;
            }
            int offset = checked((int)(position - blockOffset));
            int count = Math.Min(buffer.Length, block.Length - offset);
            block.AsMemory(offset, count).CopyTo(buffer);
            position += count;
            return count;
        }
        finally { gate.Release(); }
    }
    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) => ReadAsync(buffer.AsMemory(offset, count), ct).AsTask();
    public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
    public override long Seek(long offset, SeekOrigin origin)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        gate.Wait();
        try
        {
            long next = checked((origin switch { SeekOrigin.Begin => 0, SeekOrigin.Current => position, SeekOrigin.End => length, _ => throw new ArgumentOutOfRangeException(nameof(origin)) }) + offset);
            if (next < 0) throw new IOException("Invalid seek");
            return position = next;
        }
        finally { gate.Release(); }
    }
    public override bool CanRead => !disposed;
    public override bool CanSeek => !disposed;
    public override bool CanWrite => false;
    public override long Length => length;
    public override long Position { get => position; set => Seek(value, SeekOrigin.Begin); }
    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    protected override void Dispose(bool disposing)
    {
        if (disposing && !disposed) { disposed = true; lifetime.Cancel(); client.Dispose(); }
        base.Dispose(disposing);
    }
}
