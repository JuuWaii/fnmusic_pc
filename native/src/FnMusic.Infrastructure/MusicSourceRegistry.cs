using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FnMusic.Core;

namespace FnMusic.Infrastructure;

/// <summary>只保存账户作用域摘要与随机实例 ID，不保存地址、账号或凭据。</summary>
public sealed class MusicSourceRegistry(string directory)
{
    public static string AccountKey(ServerEndpoint endpoint, string username)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(username);
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(new[] { "fnmusic", endpoint.StorageKey, username.Trim() }))));
    }

    public static bool IsValidKey(string? key) => key is { Length: 64 } && key.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    public async Task<Guid> GetOrCreateAsync(string accountKey, CancellationToken ct)
    {
        if (!IsValidKey(accountKey)) throw new ArgumentException("Invalid source account key");
        ct.ThrowIfCancellationRequested();
        Directory.CreateDirectory(directory);
        string file = Path.Combine(directory, "sources.json");
        // 多窗口/进程同时修改时失败并允许重试，不能覆盖另一个实例的映射。
        using var guard = new FileStream(file + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        Dictionary<string, Guid> entries = [];
        if (File.Exists(file))
        {
            if (new FileInfo(file).Length > 1048576) throw new InvalidDataException();
            entries = JsonSerializer.Deserialize<Dictionary<string, Guid>>(await File.ReadAllTextAsync(file, ct))
                ?? throw new InvalidDataException();
            if (entries.Any(pair => !IsValidKey(pair.Key) || pair.Value == Guid.Empty) || entries.Values.Distinct().Count() != entries.Count)
                throw new InvalidDataException();
        }
        if (entries.TryGetValue(accountKey, out var existing)) return existing;
        Guid id = Guid.NewGuid();
        entries.Add(accountKey, id);
        string pending = file + ".tmp";
        try
        {
            await File.WriteAllTextAsync(pending, JsonSerializer.Serialize(entries), ct);
            ct.ThrowIfCancellationRequested();
            File.Move(pending, file, true);
        }
        finally { if (File.Exists(pending)) File.Delete(pending); }
        return id;
    }
}
