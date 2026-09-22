namespace FnMusic.Core;

public sealed record ConnectionSettings(string ServerAddress, string DeviceId, bool RememberSession);
public sealed record MusicUser(string Name);
public sealed record MusicTrack(string Id, string Title, string Artist, double DurationSeconds, bool IsCue)
{
    public bool IsFavorite { get; init; }
    public string DisplayDuration => TimeSpan.FromSeconds(Math.Clamp(DurationSeconds, 0, 864000)).ToString(DurationSeconds >= 3600 ? @"h\:mm\:ss" : @"m\:ss");
}
public sealed record TrackPage(IReadOnlyList<MusicTrack> Tracks, int Total);

public enum MusicFailure { Unauthorized, Unavailable, InvalidResponse, RedirectRejected, Rejected }

// 不携带服务端原始文本、URL 或响应，避免错误展示和日志意外泄露私人数据。
public sealed class MusicApiException(MusicFailure failure) : Exception(failure.ToString())
{
    public MusicFailure Failure { get; } = failure;
}

public interface ISessionVault
{
    Task<string?> LoadAsync(string connectionKey, CancellationToken cancellationToken);
    Task SaveAsync(string connectionKey, string token, CancellationToken cancellationToken);
    Task ClearAsync(string connectionKey, CancellationToken cancellationToken);
}
