using System.Security.Cryptography;
using System.Text;
using FnMusic.Core;

namespace FnMusic.Windows;

public sealed class DpapiSessionVault(string directory) : ISessionVault
{
    private string FileFor(string key)
    {
        if (key.Length != 64 || !key.All(Uri.IsHexDigit)) throw new ArgumentException("Invalid connection key");
        return Path.Combine(directory, key + ".bin");
    }
    public async Task<string?> LoadAsync(string connectionKey, CancellationToken cancellationToken)
    {
        string path = FileFor(connectionKey);
        if (!File.Exists(path)) return null;
        if (new FileInfo(path).Length > 65536) throw new CryptographicException();
        byte[] encrypted = await File.ReadAllBytesAsync(path, cancellationToken);
        byte[] clear = ProtectedData.Unprotect(encrypted, Encoding.UTF8.GetBytes(connectionKey), DataProtectionScope.CurrentUser);
        try { return Encoding.UTF8.GetString(clear); }
        finally { CryptographicOperations.ZeroMemory(clear); }
    }
    public async Task SaveAsync(string connectionKey, string token, CancellationToken cancellationToken)
    {
        string path = FileFor(connectionKey);
        byte[] clear = Encoding.UTF8.GetBytes(token);
        byte[] encrypted;
        try { encrypted = ProtectedData.Protect(clear, Encoding.UTF8.GetBytes(connectionKey), DataProtectionScope.CurrentUser); }
        finally { CryptographicOperations.ZeroMemory(clear); }
        Directory.CreateDirectory(directory);
        string pending = path + ".tmp";
        await File.WriteAllBytesAsync(pending, encrypted, cancellationToken);
        File.Move(pending, path, true);
    }
    public Task ClearAsync(string connectionKey, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try { File.Delete(FileFor(connectionKey)); }
        catch (DirectoryNotFoundException) { /* 首次登录尚无 sessions 目录，清理应是幂等操作。 */ }
        return Task.CompletedTask;
    }
}
