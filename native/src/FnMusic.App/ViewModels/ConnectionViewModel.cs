using System.ComponentModel;
using System.Runtime.CompilerServices;
using FnMusic.Core;
using FnMusic.Infrastructure;
using FnMusic.Windows;

namespace FnMusic.App.ViewModels;

public sealed class ConnectionViewModel : INotifyPropertyChanged, IDisposable
{
    private readonly ConnectionSettingsStore settingsStore;
    private readonly MusicSourceRegistry sourceRegistry;
    private readonly ISessionVault vault;
    private readonly CancellationTokenSource lifetime = new();
    private ConnectionSettings? settings;
    private NasApiClient? client;
    private ServerEndpoint? endpoint;
    private string serverAddress = "", username = "", status = "连接你的音乐资料库，开始使用原生客户端。", account = "尚未登录";
    private bool busy, rememberSession = true;
    public event PropertyChangedEventHandler? PropertyChanged;
    public event Action? SessionChanging;
    public NasApiClient? AuthenticatedClient { get; private set; }
    public string ServerAddress { get => serverAddress; set { serverAddress = value; Changed(); } }
    public string Username { get => username; set { username = value; Changed(); } }
    public bool RememberSession { get => rememberSession; set { rememberSession = value; Changed(); } }
    public string Status { get => status; private set { status = value; Changed(); } }
    public string Account { get => account; private set { account = value; Changed(); } }
    public bool IsReady => !busy;
    public bool IsBusy => busy;
    public ConnectionViewModel()
    {
        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FnMusic.Native");
        settingsStore = new ConnectionSettingsStore(data);
        sourceRegistry = new MusicSourceRegistry(data);
        vault = new DpapiSessionVault(Path.Combine(data, "sessions"));
    }
    private void Changed([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    private async Task RunAsync(Func<Task> operation)
    {
        if (busy) return;
        busy = true; Changed(nameof(IsReady)); Changed(nameof(IsBusy));
        try { await operation(); }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (MusicApiException error)
        {
            Status = error.Failure switch
            {
                MusicFailure.Unauthorized => "登录已失效，请重新登录。",
                MusicFailure.Unavailable => "暂时无法连接服务器，请检查地址和网络后重试。",
                MusicFailure.RedirectRejected => "服务器返回了重定向，请使用音乐服务的最终地址。",
                MusicFailure.InvalidResponse => "服务器响应格式与当前客户端不兼容。",
                _ => "服务器拒绝了请求，请核对账号和连接设置。"
            };
        }
        catch (ArgumentException) { Status = "地址格式不正确，请输入 HTTP 或 HTTPS 地址，可带 /music/。"; }
        catch (Exception) { Status = "无法读取或保存本机设置，请重试。未将凭据保存为明文。"; }
        finally { busy = false; Changed(nameof(IsReady)); Changed(nameof(IsBusy)); }
    }
    public Task InitializeAsync() => RunAsync(async () =>
    {
        settings = await settingsStore.LoadAsync(lifetime.Token);
        if (settings is null) return;
        ServerAddress = settings.ServerAddress; RememberSession = settings.RememberSession;
        endpoint = ServerEndpoint.Parse(ServerAddress); client = new NasApiClient(endpoint);
        if (!RememberSession) return;
        var token = await vault.LoadAsync(endpoint.StorageKey, lifetime.Token);
        if (token is null) return;
        if (settings.SourceAccountKey is null)
        { Status = "音乐源身份已升级，请重新登录一次以关联当前账号。"; return; }
        client.RestoreSession(token);
        try
        {
            Account = (await client.GetCurrentUserAsync(lifetime.Token)).Name;
            await ActivateSourceAsync(token, settings.SourceAccountKey);
            Status = "已恢复登录，可以打开音乐资料库。";
        }
        catch (MusicApiException ex) when (ex.Failure == MusicFailure.Unauthorized)
        { await vault.ClearAsync(endpoint.StorageKey, lifetime.Token); throw; }
    });
    public Task SaveConnectionAsync() => RunAsync(async () =>
    {
        var next = ServerEndpoint.Parse(ServerAddress);
        SessionChanging?.Invoke(); AuthenticatedClient = null;
        if (endpoint is not null && next.StorageKey != endpoint.StorageKey)
            await vault.ClearAsync(endpoint.StorageKey, lifetime.Token);
        bool same = endpoint?.StorageKey == next.StorageKey;
        var updated = new ConnectionSettings(next.MusicUri.AbsoluteUri, same && settings is not null ? settings.DeviceId : Guid.NewGuid().ToString("N"), RememberSession)
        { SourceAccountKey = same ? settings?.SourceAccountKey : null };
        await settingsStore.SaveAsync(updated, lifetime.Token);
        if (!RememberSession) await vault.ClearAsync(next.StorageKey, lifetime.Token);
        settings = updated; endpoint = next; client?.Dispose(); client = new NasApiClient(next);
        Account = "尚未登录"; ServerAddress = updated.ServerAddress;
        Status = await client.CheckConnectionAsync(lifetime.Token) ? "连接成功，可以登录音乐服务。" : "服务尚未初始化，请先在 NAS 上完成初始化。";
    });
    public Task LoginAsync(string password) => RunAsync(async () =>
    {
        if (settings is null || endpoint is null || client is null || ServerAddress != settings.ServerAddress)
        { Status = "请先保存并连接服务器。"; return; }
        if (string.IsNullOrWhiteSpace(Username) || string.IsNullOrEmpty(password))
        { Status = "请输入账号和密码。"; return; }
        string loginUsername = Username.Trim();
        // 先撤销旧的本地持久状态，失败登录不能恢复此前账户。
        SessionChanging?.Invoke(); AuthenticatedClient = null;
        await vault.ClearAsync(endpoint.StorageKey, lifetime.Token);
        Account = "尚未登录";
        try
        {
            string token = await client.LoginAsync(loginUsername, password, settings.DeviceId, lifetime.Token);
            var user = await client.GetCurrentUserAsync(lifetime.Token);
            string accountKey = MusicSourceRegistry.AccountKey(endpoint, loginUsername);
            settings = settings with { RememberSession = RememberSession, SourceAccountKey = accountKey };
            await settingsStore.SaveAsync(settings, lifetime.Token);
            // 先保存归属，再保存新令牌；中途退出不能把新账户会话关联到旧账户来源。
            if (RememberSession) await vault.SaveAsync(endpoint.StorageKey, token, lifetime.Token);
            await ActivateSourceAsync(token, accountKey);
            Account = user.Name; Status = "登录成功，可以打开音乐资料库。";
        }
        catch
        {
            client.ClearSession();
            await vault.ClearAsync(endpoint.StorageKey, CancellationToken.None);
            throw;
        }
    });
    private async Task ActivateSourceAsync(string token, string accountKey)
    {
        Guid sourceId = await sourceRegistry.GetOrCreateAsync(accountKey, lifetime.Token);
        var scoped = new NasApiClient(endpoint!, sourceInstanceId: sourceId);
        scoped.RestoreSession(token);
        client?.Dispose();
        client = scoped;
        AuthenticatedClient = scoped;
    }
    public Task LogoutAsync() => RunAsync(async () =>
    {
        if (endpoint is null || client is null) return;
        SessionChanging?.Invoke(); AuthenticatedClient = null;
        await vault.ClearAsync(endpoint.StorageKey, lifetime.Token);
        Account = "尚未登录";
        try { await client.LogoutAsync(lifetime.Token); Status = "已退出登录。"; }
        catch (MusicApiException) { Status = "已清理本机登录；服务器未确认退出。"; }
    });
    public async Task ExpireSessionAsync()
    {
        SessionChanging?.Invoke(); AuthenticatedClient = null;
        client?.ClearSession(); Account = "尚未登录";
        Status = "登录已失效，请重新登录。";
        if (endpoint is null) return;
        try { await vault.ClearAsync(endpoint.StorageKey, lifetime.Token); }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception) { Status = "登录已失效。本机保存的会话未能删除，请重试退出登录。"; }
    }
    public void Dispose() { lifetime.Cancel(); client?.Dispose(); lifetime.Dispose(); }
}
