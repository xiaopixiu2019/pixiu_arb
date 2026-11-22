using System;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

internal sealed class ConnectionProfile
{
    internal string Address;
    internal string User;
    internal int SshPort;
    internal int LocalPort;
    internal int ServicePort;
    internal string HostKey;

    private static readonly Regex UserPattern = new Regex(@"^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$");
    private static readonly Regex KeyPattern = new Regex(@"^ssh-ed25519 (AAAA[A-Za-z0-9+/=]{60,100})(?:[ \t]+[^\r\n]*)?$");

    internal static ConnectionProfile Parse(string[] values)
    {
        if (values == null || values.Length != 6) throw new ArgumentException("Connection profile is incomplete.");
        IPAddress address;
        if (!Regex.IsMatch(values[0].Trim(), @"^(?:\d{1,3}\.){3}\d{1,3}$")
            || !IPAddress.TryParse(values[0].Trim(), out address)
            || address.AddressFamily != AddressFamily.InterNetwork || address.Equals(IPAddress.Any))
            throw new ArgumentException("Enter a valid server IPv4 address.");
        string user = values[1].Trim();
        if (!UserPattern.IsMatch(user)) throw new ArgumentException("Enter the SSH account name supplied by your administrator.");
        var match = KeyPattern.Match(values[5].Trim());
        if (!match.Success || !ValidEd25519Blob(match.Groups[1].Value))
            throw new ArgumentException("Paste the server's ssh-ed25519 host public key.");
        return new ConnectionProfile
        {
            Address = address.ToString(), User = user, SshPort = ParsePort(values[2]),
            LocalPort = ParsePort(values[3]), ServicePort = ParsePort(values[4]),
            HostKey = "ssh-ed25519 " + match.Groups[1].Value
        };
    }

    private static bool ValidEd25519Blob(string encoded)
    {
        try
        {
            var data = Convert.FromBase64String(encoded);
            return data.Length == 51 && data[0] == 0 && data[1] == 0 && data[2] == 0 && data[3] == 11
                && Encoding.ASCII.GetString(data, 4, 11) == "ssh-ed25519"
                && data[15] == 0 && data[16] == 0 && data[17] == 0 && data[18] == 32;
        }
        catch (FormatException) { return false; }
    }

    private static int ParsePort(string value)
    {
        int port;
        if (!Int32.TryParse(value.Trim(), out port) || port < 1 || port > 65535)
            throw new ArgumentException("Ports must be between 1 and 65535.");
        return port;
    }

    internal static ConnectionProfile Load(string path)
    {
        return File.Exists(path) ? Parse(File.ReadAllLines(path, Encoding.UTF8)) : null;
    }

    internal void Save(string path)
    {
        File.WriteAllLines(path, new[] { Address, User, SshPort.ToString(), LocalPort.ToString(),
            ServicePort.ToString(), HostKey }, new UTF8Encoding(false));
    }

    internal static ConnectionProfile Ask()
    {
        using (var form = new Form())
        {
            form.Text = "PIXIU ARB SSH Connection";
            form.StartPosition = FormStartPosition.CenterScreen;
            form.Font = new Font("Segoe UI", 10F);
            form.ClientSize = new Size(595, 322);
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            var descriptions = new[] { "服务器 IPv4", "SSH 用户名", "SSH 端口", "电脑本地端口", "服务器网页端口", "服务器主机公钥" };
            var defaults = new[] { "", "", "22", "17840", "17840", "" };
            var fields = new TextBox[defaults.Length];
            for (int i = 0; i < defaults.Length; i++)
            {
                var label = new Label { Text = descriptions[i], AutoSize = true };
                label.Location = new Point(16, 18 + 37 * i);
                fields[i] = new TextBox { Text = defaults[i] };
                fields[i].SetBounds(169, 14 + 37 * i, 405, 27);
                form.Controls.Add(label);
                form.Controls.Add(fields[i]);
            }

            ConnectionProfile selected = null;
            var help = new Label { Text = "请从服务器管理员处取得并核验主机公钥。", AutoSize = true };
            help.Location = new Point(16, 242);
            var save = new Button { Text = "保存并连接" };
            save.SetBounds(449, 272, 125, 34);
            save.Click += delegate
            {
                try
                {
                    var values = Array.ConvertAll(fields, field => field.Text);
                    selected = Parse(values);
                    form.Close();
                }
                catch (ArgumentException error) { MessageBox.Show(form, error.Message, form.Text); }
            };
            form.Controls.AddRange(new Control[] { help, save });
            form.AcceptButton = save;
            form.ShowDialog();
            return selected;
        }
    }
}
