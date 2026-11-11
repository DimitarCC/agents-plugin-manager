using System;
using System.Windows;
using System.Windows.Media;
using Microsoft.VisualStudio.PlatformUI;
using WpfColor = System.Windows.Media.Color;

namespace AgentsPluginsPackageManager.UI
{
    /// <summary>
    /// Derives a small WinUI-like palette from the live Visual Studio theme (light, dark, blue, high contrast)
    /// and publishes it as brushes that Styles.xaml consumes through DynamicResource.
    /// </summary>
    internal static class Theme
    {
        public static void Apply(ResourceDictionary r)
        {
            var bg = ToWpf(VSColorTheme.GetThemedColor(EnvironmentColors.ToolWindowBackgroundColorKey));
            var fg = ToWpf(VSColorTheme.GetThemedColor(EnvironmentColors.ToolWindowTextColorKey));
            var dark = Luminance(bg) < 0.5;

            var accent = dark ? WpfColor.FromRgb(0x4C, 0xC2, 0xFF) : WpfColor.FromRgb(0x00, 0x67, 0xC0);
            var accentFg = dark ? WpfColor.FromRgb(0x00, 0x1B, 0x2E) : Colors.White;

            Set(r, "Bg", bg);
            Set(r, "Fg", fg);
            Set(r, "Muted", Mix(bg, fg, 0.68));
            Set(r, "PanelBg", Mix(bg, fg, dark ? 0.035 : 0.025));
            Set(r, "PopupBg", Mix(bg, fg, dark ? 0.09 : 0.0));
            Set(r, "Surface", Mix(bg, fg, dark ? 0.075 : 0.045));
            Set(r, "SurfaceHover", Mix(bg, fg, dark ? 0.12 : 0.085));
            Set(r, "Stroke", Mix(bg, fg, dark ? 0.2 : 0.16));
            Set(r, "StrongStroke", Mix(bg, fg, 0.55));
            Set(r, "Accent", accent);
            Set(r, "AccentFg", accentFg);
            Set(r, "AccentSoft", Mix(bg, accent, dark ? 0.22 : 0.14));
            Set(r, "Warn", dark ? WpfColor.FromRgb(0xFF, 0xB9, 0x00) : WpfColor.FromRgb(0x9D, 0x5D, 0x00));
        }

        /// <summary>Re-applies the palette whenever the user switches Visual Studio themes.</summary>
        public static void Track(FrameworkElement owner)
        {
            ThemeChangedEventHandler handler = e => owner.Dispatcher.BeginInvoke(new Action(() => Apply(owner.Resources)));
            owner.Loaded += (s, e) => { VSColorTheme.ThemeChanged -= handler; VSColorTheme.ThemeChanged += handler; Apply(owner.Resources); };
            owner.Unloaded += (s, e) => VSColorTheme.ThemeChanged -= handler;
        }

        private static void Set(ResourceDictionary r, string key, WpfColor c)
        {
            var b = new SolidColorBrush(c);
            b.Freeze();
            r[key] = b;
        }

        private static WpfColor ToWpf(System.Drawing.Color c) => WpfColor.FromArgb(255, c.R, c.G, c.B);

        private static double Luminance(WpfColor c) => (0.2126 * c.R + 0.7152 * c.G + 0.0722 * c.B) / 255.0;

        private static WpfColor Mix(WpfColor a, WpfColor b, double t) => WpfColor.FromRgb(
            (byte)Math.Round(a.R + (b.R - a.R) * t),
            (byte)Math.Round(a.G + (b.G - a.G) * t),
            (byte)Math.Round(a.B + (b.B - a.B) * t));
    }
}
