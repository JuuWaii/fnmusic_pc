using System.Text.Json;
using FnMusic.Core;

namespace FnMusic.Infrastructure;

public sealed class ConnectionSettingsStore(string directory)
{
    private readonly string file = Path.Combine(directory, "connection.json");
    public async Task<ConnectionSettings?> LoadAsync(CancellationToken ct)
    {
        if (!File.Exists(file)) return null;
        if (new FileInfo(file).Length > 16384) throw new InvalidDataException();
        var settings = JsonSerializer.Deserialize<ConnectionSettings>(await File.ReadAllTextAsync(file, ct));
        if (settings is null || settings.DeviceId.Length != 32 || !settings.DeviceId.All(Uri.IsHexDigit)) throw new InvalidDataException();
        _ = ServerEndpoint.Parse(settings.ServerAddress);
        return settings;
    }
    public async Task SaveAsync(ConnectionSettings settings, CancellationToken ct)
    {
        Directory.CreateDirectory(directory);
        string pending = file + ".tmp";
        await File.WriteAllTextAsync(pending, JsonSerializer.Serialize(settings), ct);
        File.Move(pending, file, true);
    }
}
