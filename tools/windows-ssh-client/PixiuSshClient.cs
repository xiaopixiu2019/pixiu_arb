using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.NetworkInformation;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Xml;
using System.Xml.Linq;

internal static class PixiuSshClient
{
    private const string Alias = "pixiu-ssh-target";
    private const string TaskName = "PixiuArbPublicSsh";
    private static ConnectionProfile Profile;
    private static string Url { get { return "http://127.0.0.1:" + Profile.LocalPort; } }
    private static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PixiuArbPublicSsh");
    private static readonly string Key = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".ssh", "pixiu_arb_ssh_client");
    private static readonly string Config = Path.Combine(Root, "ssh_config");
    private static readonly string ProfilePath = Path.Combine(Root, "server-profile");
    private static readonly string NetworkPreference = Path.Combine(Root, "network-mode");
    private static readonly string Hosts = Path.Combine(Root, "known_hosts");
    private static readonly string Installed = Path.Combine(Root, "Pixiu-ARB-SSH.exe");
    private static readonly string SystemDir = Environment.GetFolderPath(Environment.SpecialFolder.System);
    private static readonly string Ssh = Path.Combine(SystemDir, "OpenSSH", "ssh.exe");
    private static readonly string Keygen = Path.Combine(SystemDir, "OpenSSH", "ssh-keygen.exe");
    private static readonly string Scheduler = Path.Combine(SystemDir, "schtasks.exe");
    private static readonly Encoding Utf8 = new UTF8Encoding(false);
    private static readonly XNamespace TaskNs = "http://schemas.microsoft.com/windows/2004/02/mit/task";

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test")
        {
            try { return SelfTest(); } catch { return 10; }
        }
        if (args.Length == 1 && args[0] == "--guardian")
        {
            try { Profile = ConnectionProfile.Load(ProfilePath); return Profile == null ? 2 : RunGuardian(); }
            catch (Exception) { return 2; }
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var mutex = new Mutex(false, @"Local\PixiuArbPublicSshLauncher"))
        {
            if (!mutex.WaitOne(0)) return 0;
            try
            {
                Profile = ConnectionProfile.Load(ProfilePath);
                if (Profile == null)
                {
                    Profile = ConnectionProfile.Ask();
                    if (Profile == null) return 0;
                    Directory.CreateDirectory(Root);
                    Profile.Save(ProfilePath);
                }
                Application.Run(new Launcher());
            }
            catch (Exception error) { MessageBox.Show(error.Message, "PIXIU ARB SSH连接"); }
            finally { mutex.ReleaseMutex(); }
        }
        return 0;
    }

    private sealed class Launcher : Form
    {
        private readonly Label status = new Label();
        private readonly TextBox key = new TextBox();
        private readonly Button copy = new Button();
        private readonly Button connect = new Button();
        private readonly CheckBox systemNetwork = new CheckBox();

        internal Launcher()
        {
            Text = "PIXIU ARB SSH连接";
            Font = new Font("Segoe UI", 10F);
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(566, 222);
            MinimumSize = new Size(510, 245);

            status.SetBounds(20, 20, 526, 68);
            status.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            key.SetBounds(20, 91, 526, 28);
            key.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            key.ReadOnly = true;
            key.TabStop = false;
            copy.Text = "复制公钥";
            copy.SetBounds(20, 153, 125, 34);
            connect.Text = "重新连接";
            connect.SetBounds(421, 153, 125, 34);
            connect.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            copy.Click += delegate {
                try { Clipboard.SetText(key.Text); status.Text = "公钥已复制，发给管理员登记后，点「重新连接」。"; }
                catch (Exception) { status.Text = "剪贴板暂时不可用，请选中上面的公钥并复制。"; }
            };
            connect.Click += delegate { Connect(); };
            systemNetwork.Text = "使用系统网络（可能经过 Clash）";
            systemNetwork.SetBounds(20, 122, 410, 26);
            systemNetwork.Checked = UseSystemNetwork();
            Controls.AddRange(new Control[] { status, key, copy, connect, systemNetwork });
            Shown += delegate { Connect(); };
        }

        private async void Connect()
        {
            connect.Enabled = false;
            copy.Enabled = false;
            systemNetwork.Enabled = false;
            var useSystemNetwork = systemNetwork.Checked;
            status.Text = "正在检查PIXIU ARB 的连接…";
            try
            {
                key.Text = await Task.Run((Func<string>)PrepareClient);
                var result = await Task.Run(() => ConnectAccount(useSystemNetwork));
                if (result.Connected)
                {
                    Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
                    if (result.Message == null) { Close(); return; }
                }
                status.Text = result.Message;
            }
            catch (Exception error) { status.Text = error.Message; }
            finally
            {
                if (!IsDisposed)
                {
                    copy.Enabled = key.Text.Length > 0;
                    connect.Enabled = true;
                    systemNetwork.Enabled = true;
                }
            }
        }
    }

    private static string PrepareClient()
    {
        if (!File.Exists(Ssh) || !File.Exists(Keygen))
            throw new InvalidOperationException("请在 Windows「设置 → 可选功能」安装 OpenSSH 客户端，然后重新打开。");
        Directory.CreateDirectory(Root);
        Directory.CreateDirectory(Path.GetDirectoryName(Key));
        if (!File.Exists(Key))
        {
            if (File.Exists(Key + ".pub"))
                throw new InvalidOperationException("检测到公钥但找不到对应私钥。请先恢复原来的专用钥匙。");
            var gen = Run(Keygen, "-q -t ed25519 -N \"\" -C pixiu-terminal -f " + Quote(Key), 12000);
            if (gen.Code != 0) throw new InvalidOperationException("生成专用 SSH 钥匙失败，请检查本机用户目录权限。");
        }
        if (!File.Exists(Key + ".pub"))
            throw new InvalidOperationException("专用公钥文件缺失。请恢复 .ssh\\pixiu_arb_ssh_client.pub。");
        var key = File.ReadAllText(Key + ".pub").Trim();
        if (!key.StartsWith("ssh-ed25519 ", StringComparison.Ordinal) || key.IndexOfAny(new[] { '\r', '\n' }) >= 0)
            throw new InvalidOperationException("本机专用公钥格式无效。");

        WriteIfChanged(Hosts, Alias + " " + Profile.HostKey + "\n");
        WriteIfChanged(Config, MakeSshConfig(Profile, Key, Hosts));
        return key;
    }

    private sealed class ConnectionOutcome
    {
        internal readonly bool Connected;
        internal readonly string Message;
        internal ConnectionOutcome(bool connected, string message) { Connected = connected; Message = message; }
    }

    private static ConnectionOutcome ConnectAccount(bool useSystemNetwork)
    {
        Result remote;
        using (var bridge = useSystemNetwork ? null : new PhysicalBridge())
            remote = Run(Ssh, SshArgs(bridge) + " -W 127.0.0.1:" + Profile.ServicePort + " pixiu-terminal", 25000,
                "GET /health HTTP/1.1\r\nHost: 127.0.0.1:" + Profile.ServicePort + "\r\nConnection: close\r\n\r\n");
        if (!ValidHealth(remote.Output, true))
            return new ConnectionOutcome(false, ExplainFailedProbe(remote));

        WriteIfChanged(NetworkPreference, useSystemNetwork ? "system" : "physical");
        if (!LocalHealthy() && CanListen())
        {
            if (!String.Equals(Application.ExecutablePath, Installed, StringComparison.OrdinalIgnoreCase))
                File.Copy(Application.ExecutablePath, Installed, true);
            using (Process.Start(new ProcessStartInfo(Installed, "--guardian")
                { UseShellExecute = false, CreateNoWindow = true })) { }
        }

        for (var i = 0; i < 15; i++)
        {
            if (LocalHealthy()) return ConfirmAutomaticStartup();
            Thread.Sleep(700);
        }
        return new ConnectionOutcome(false, "服务器已连通，但本机网页没启动。请关闭占用该端口的旧隧道后重试。");
    }

    private static bool UseSystemNetwork()
    {
        try { return File.Exists(NetworkPreference) && File.ReadAllText(NetworkPreference).Trim() == "system"; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    private static string ExplainFailedProbe(Result remote)
    {
        if (remote.Error.IndexOf("Permission denied", StringComparison.OrdinalIgnoreCase) >= 0)
            return "服务器还没接受这把钥匙。首次使用请复制公钥发给管理员。";
        if (remote.Error.IndexOf("host key", StringComparison.OrdinalIgnoreCase) >= 0)
            return "服务器身份核验失败，连接已停止。请联系管理员核对主机公钥。";
        if (remote.Output.StartsWith("HTTP/", StringComparison.Ordinal))
            return "SSH 已连通，但PIXIU ARB 网页没有返回正常结果。请联系管理员。";
        return "SSH 连接未完成。请检查网络后点「重新连接」。";
    }

    private static ConnectionOutcome ConfirmAutomaticStartup()
    {
        try
        {
            if (!TaskIsInstalled()) InstallTask();
            return new ConnectionOutcome(true, null);
        }
        catch (Exception error)
        {
            return new ConnectionOutcome(true, "已连接并打开网页。登录自启动暂未设置：" + error.Message + "。下次双击仍可连接。");
        }
    }

    private static bool TaskIsInstalled()
    {
        var result = Run(Scheduler, "/Query /TN " + Quote(TaskName) + " /XML", 8000);
        if (result.Code != 0) return false;
        var document = XDocument.Parse(result.Output.TrimStart('\uFEFF', ' ', '\r', '\n'));
        var command = document.Root.Element(TaskNs + "Actions").Element(TaskNs + "Exec");
        if (!String.Equals((string)command.Element(TaskNs + "Command"), Installed, StringComparison.OrdinalIgnoreCase)
            || (string)command.Element(TaskNs + "Arguments") != "--guardian" || !File.Exists(Installed))
            throw new InvalidOperationException("发现同名但不匹配的计划任务，请联系管理员核对。");
        return true;
    }

    private static void InstallTask()
    {
        if (!File.Exists(Installed))
            File.Copy(Application.ExecutablePath, Installed, false);
        var sid = WindowsIdentity.GetCurrent().User.Value;
        var xmlPath = Path.Combine(Root, "account-b-task.xml");
        SaveTaskDefinition(xmlPath, MakeTask(sid, Installed));
        var result = Run(Scheduler, "/Create /TN " + Quote(TaskName) + " /XML " + Quote(xmlPath), 10000);
        if (result.Code != 0 || !TaskIsInstalled())
            throw new InvalidOperationException("Windows 任务注册失败，返回码 " + result.Code);
    }

    private static void SaveTaskDefinition(string path, XDocument task)
    {
        // The Windows schtasks XML import accepts the UTF-16LE BOM on systems
        // where its importer rejects an otherwise valid UTF-8 document.
        var options = new XmlWriterSettings { Encoding = Encoding.Unicode, Indent = true };
        using (var writer = XmlWriter.Create(path, options)) task.Save(writer);
    }

    private static XDocument MakeTask(string sid, string executable)
    {
        return new XDocument(new XElement(TaskNs + "Task", new XAttribute("version", "1.2"),
            E("RegistrationInfo", E("Description", "PIXIU ARB SSH tunnel")),
            E("Triggers", E("LogonTrigger", E("Enabled", "true"), E("UserId", sid))),
            E("Principals", new XElement(TaskNs + "Principal", new XAttribute("id", "CurrentUser"),
                E("UserId", sid), E("LogonType", "InteractiveToken"), E("RunLevel", "LeastPrivilege"))),
            E("Settings", E("MultipleInstancesPolicy", "IgnoreNew"), E("DisallowStartIfOnBatteries", "false"),
                E("StopIfGoingOnBatteries", "false"), E("StartWhenAvailable", "true"), E("ExecutionTimeLimit", "PT0S"),
                E("RestartOnFailure", E("Interval", "PT1M"), E("Count", "5"))),
            new XElement(TaskNs + "Actions", new XAttribute("Context", "CurrentUser"),
                E("Exec", E("Command", executable), E("Arguments", "--guardian")))));
    }

    private static XElement E(string tag, params object[] content) { return new XElement(TaskNs + tag, content); }

    private static string MakeSshConfig(ConnectionProfile profile, string key, string hosts)
    {
        return String.Join("\n", new[] {
            "Host pixiu-terminal", "  HostName " + profile.Address, "  User " + profile.User, "  Port " + profile.SshPort,
            "  IdentityFile " + Quote(key.Replace('\\','/')), "  IdentitiesOnly yes",
            "  PreferredAuthentications publickey", "  BatchMode yes", "  StrictHostKeyChecking yes",
            "  HostKeyAlias " + Alias, "  HostKeyAlgorithms ssh-ed25519", "  GlobalKnownHostsFile none",
            "  UserKnownHostsFile " + Quote(hosts.Replace('\\','/')), "  LocalForward 127.0.0.1:" + profile.LocalPort + " 127.0.0.1:" + profile.ServicePort,
            "  ExitOnForwardFailure yes", "  ConnectTimeout 12", "  ServerAliveInterval 15", "  ServerAliveCountMax 3", ""
        });
    }

    private static int RunGuardian()
    {
        using (var onlyOne = new Mutex(false, @"Local\PixiuArbPublicSsh-" + WindowsIdentity.GetCurrent().User.Value))
        {
            try { if (!onlyOne.WaitOne(0)) return 0; }
            catch (AbandonedMutexException) { }
            try { return GuardTunnel(); }
            finally { onlyOne.ReleaseMutex(); }
        }
    }

    private static int GuardTunnel()
    {
        try
        {
            if (!File.Exists(Config) || !File.Exists(Ssh)) return 2;
            var log = Path.Combine(Root, "tunnel.log");
            for (;;)
            {
                File.WriteAllText(log, DateTimeOffset.Now.ToString("O") + " SSH attempt\n", Utf8);
                try
                {
                    using (var bridge = UseSystemNetwork() ? null : new PhysicalBridge())
                    using (var process = Process.Start(new ProcessStartInfo(Ssh, SshArgs(bridge) + " -N -T -E " + Quote(log) + " pixiu-terminal")
                        { UseShellExecute = false, CreateNoWindow = true }))
                    {
                        process.WaitForExit();
                        File.AppendAllText(log, "SSH exited: " + process.ExitCode + "\n", Utf8);
                    }
                }
                catch (InvalidOperationException error) { File.AppendAllText(log, error.Message + "\n", Utf8); }
                Thread.Sleep(8000);
            }
        }
        catch (Exception) { return 3; }
    }

    private sealed class PhysicalRoute
    {
        internal int Index;
        internal IPAddress Source;
        internal bool HasGateway;
    }

    private static HashSet<int> PhysicalAdapterIndices()
    {
        const string script = "$ErrorActionPreference='Stop';"
            + "Get-NetAdapter -Physical | Where-Object Status -eq Up | ForEach-Object { $_.InterfaceIndex }";
        var powershell = Path.Combine(SystemDir, "WindowsPowerShell", "v1.0", "powershell.exe");
        var result = Run(powershell, "-NoLogo -NoProfile -NonInteractive -EncodedCommand "
            + Convert.ToBase64String(Encoding.Unicode.GetBytes(script)), 4000);
        var indices = new HashSet<int>();
        if (result.Code != 0) return indices;
        foreach (var line in result.Output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            int index;
            if (Int32.TryParse(line.Trim(), out index) && index > 0) indices.Add(index);
        }
        return indices;
    }

    private static bool CanTryAdapter(NetworkInterfaceType type, bool reportedPhysical)
    {
        return reportedPhysical || type == NetworkInterfaceType.Wireless80211;
    }

    private static bool IsUsableSource(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(address)
            || address.Equals(IPAddress.Any)) return false;
        var bytes = address.GetAddressBytes();
        return bytes[0] != 169 || bytes[1] != 254;
    }

    private static List<PhysicalRoute> FindRoutes()
    {
        var physical = PhysicalAdapterIndices();
        var routes = new List<PhysicalRoute>();
        foreach (var adapter in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (adapter.OperationalStatus != OperationalStatus.Up || !adapter.Supports(NetworkInterfaceComponent.IPv4)) continue;
            try
            {
                var properties = adapter.GetIPProperties();
                var ipv4 = properties.GetIPv4Properties();
                if (ipv4 == null || !CanTryAdapter(adapter.NetworkInterfaceType, physical.Contains(ipv4.Index))) continue;
                bool hasGateway = false;
                foreach (var gateway in properties.GatewayAddresses)
                    if (IsUsableSource(gateway.Address)) { hasGateway = true; break; }
                foreach (var entry in properties.UnicastAddresses)
                    if (IsUsableSource(entry.Address) && entry.DuplicateAddressDetectionState == DuplicateAddressDetectionState.Preferred)
                        routes.Add(new PhysicalRoute { Index = ipv4.Index, Source = entry.Address, HasGateway = hasGateway });
            }
            catch (NetworkInformationException) { /* Adapter state changed during enumeration. */ }
        }
        routes.Sort((a, b) => b.HasGateway.CompareTo(a.HasGateway));
        if (routes.Count > 4) routes.RemoveRange(4, routes.Count - 4);
        return routes;
    }

    private static Socket OpenPhysicalSocket(PhysicalRoute route, int timeout)
    {
        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        try
        {
            // Winsock IP_UNICAST_IF expects the interface index in network byte order.
            socket.SetSocketOption(SocketOptionLevel.IP, (SocketOptionName)31,
                BitConverter.GetBytes(IPAddress.HostToNetworkOrder(route.Index)));
            socket.Bind(new IPEndPoint(route.Source, 0));
            var pending = socket.BeginConnect(new IPEndPoint(IPAddress.Parse(Profile.Address), Profile.SshPort), null, null);
            using (var completion = pending.AsyncWaitHandle)
                if (!completion.WaitOne(timeout)) throw new TimeoutException();
            socket.EndConnect(pending);
            socket.NoDelay = true;
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private sealed class PhysicalBridge : IDisposable
    {
        private readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
        private readonly Socket remote;
        private TcpClient local;
        private readonly Thread relay;
        internal int Port { get { return ((IPEndPoint)listener.LocalEndpoint).Port; } }

        internal PhysicalBridge()
        {
            var routes = FindRoutes();
            if (routes.Count == 0) throw new InvalidOperationException("没有找到可用于直连的 IPv4 地址。可勾选「使用系统网络」再点「重新连接」。");
            foreach (var route in routes)
            {
                try { remote = OpenPhysicalSocket(route, 3000); break; }
                catch (SocketException) { }
                catch (TimeoutException) { }
            }
            if (remote == null)
                throw new InvalidOperationException("已识别网卡，但当前网络无法直接访问指定服务器的 SSH 端口。可勾选「使用系统网络」再试。");
            listener.ExclusiveAddressUse = true;
            try { listener.Start(1); }
            catch { remote.Dispose(); throw; }
            relay = new Thread(Work) { IsBackground = true };
            relay.Start();
        }

        private void Work()
        {
            try
            {
                using (local = listener.AcceptTcpClient())
                using (var server = new NetworkStream(remote))
                using (var client = local.GetStream())
                {
                    local.NoDelay = true;
                    var upstream = new Thread(delegate() { Pump(client, server, remote); }) { IsBackground = true };
                    upstream.Start();
                    Pump(server, client, local.Client);
                }
            }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
            finally { remote.Dispose(); }
        }

        public void Dispose()
        {
            listener.Stop();
            if (local != null) local.Close();
            remote.Dispose();
            relay.Join(500);
        }
    }

    private static void Pump(Stream input, Stream output, Socket destination)
    {
        try
        {
            var bytes = new byte[8192];
            int count;
            while ((count = input.Read(bytes, 0, bytes.Length)) > 0) output.Write(bytes, 0, count);
            destination.Shutdown(SocketShutdown.Send);
        }
        catch (IOException) { }
        catch (SocketException) { }
        catch (ObjectDisposedException) { }
    }

    private static string SshArgs(PhysicalBridge bridge)
    {
        return "-F " + Quote(Config) + (bridge == null ? "" : " -o HostName=127.0.0.1 -p " + bridge.Port);
    }

    private static bool ValidHealth(string response, bool rawHttp)
    {
        return (!rawHttp || response.StartsWith("HTTP/1.1 200 ", StringComparison.Ordinal))
            && response.Contains("\"ok\":true") && response.Contains("\"database\":\"ok\"");
    }

    private static bool LocalHealthy()
    {
        try
        {
            var request = WebRequest.CreateHttp(Url + "/health");
            request.Proxy = null;
            request.Timeout = 1500;
            request.ReadWriteTimeout = 1500;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
                return ValidHealth(reader.ReadToEnd(), false);
        }
        catch (WebException) { return false; }
    }

    private static bool CanListen()
    {
        var listener = new TcpListener(IPAddress.Loopback, Profile.LocalPort);
        listener.ExclusiveAddressUse = true;
        try { listener.Start(); return true; }
        catch (SocketException) { return false; }
        finally { listener.Stop(); }
    }

    private static void WriteIfChanged(string path, string contents)
    {
        if (File.Exists(path) && File.ReadAllText(path) == contents) return;
        File.WriteAllText(path, contents, Utf8);
    }

    private sealed class Result
    {
        internal int Code;
        internal string Output;
        internal string Error;
    }

    private static Result Run(string exe, string args, int timeout, string input = null)
    {
        using (var p = Process.Start(new ProcessStartInfo(exe, args)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true,
            RedirectStandardOutput = true, RedirectStandardInput = input != null
        }))
        {
            var stdout = p.StandardOutput.ReadToEndAsync();
            var stderr = p.StandardError.ReadToEndAsync();
            if (input != null)
            {
                try { p.StandardInput.Write(input); p.StandardInput.Close(); }
                catch (IOException) { }
            }
            if (!p.WaitForExit(timeout))
            {
                try { p.Kill(); } catch (InvalidOperationException) { }
                return new Result { Code = -1, Output = "", Error = "Connection timed out" };
            }
            return new Result { Code = p.ExitCode, Output = stdout.Result, Error = stderr.Result };
        }
    }

    private static string Quote(string value) { return "\"" + value + "\""; }

    private static int SelfTest()
    {
        var fake = new byte[51];
        fake[3] = 11; fake[18] = 32;
        Encoding.ASCII.GetBytes("ssh-ed25519").CopyTo(fake, 4);
        var values = new[] { "192.0.2.8", "viewer", "2222", "18080", "17840", "ssh-ed25519 " + Convert.ToBase64String(fake) };
        var profile = ConnectionProfile.Parse(values);
        var config = MakeSshConfig(profile, @"C:\Test User\key", @"C:\Test User\known_hosts");
        var task = MakeTask("S-1-5-21-1-2-3-1001", @"C:\Test User\Pixiu-ARB-SSH.exe");
        if (!config.Contains("StrictHostKeyChecking yes")
            || !config.Contains("LocalForward 127.0.0.1:18080 127.0.0.1:17840")
            || !config.Contains("User viewer") || !config.Contains("Port 2222")
            || !task.ToString().Contains("InteractiveToken") || !task.ToString().Contains("LeastPrivilege")) return 12;
        if (!ValidHealth("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"database\":\"ok\"}", true)
            || ValidHealth("HTTP/1.1 500 Error\r\n\r\n{\"ok\":true,\"database\":\"ok\"}", true)) return 13;
        if (!CanTryAdapter(NetworkInterfaceType.Wireless80211, false)
            || CanTryAdapter(NetworkInterfaceType.Tunnel, false)
            || IsUsableSource(IPAddress.Parse("169.254.1.2"))
            || !IsUsableSource(IPAddress.Parse("192.0.2.10"))) return 14;
        foreach (int field in new[] { 0, 1, 2, 3, 4, 5 })
        {
            var invalid = (string[])values.Clone();
            invalid[field] = "invalid\nLocalForward 0.0.0.0:18080 127.0.0.1:22";
            try { ConnectionProfile.Parse(invalid); return 15; }
            catch (ArgumentException) { }
        }
        return 0;
    }
}
