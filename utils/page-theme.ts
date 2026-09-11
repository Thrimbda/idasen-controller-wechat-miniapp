type Theme = "light" | "dark";

/** Keep the native page chrome and controls in sync with the WXSS theme. */
export function bindPageTheme(onChange?: (theme: Theme) => void): () => void {
  const apply = (theme: Theme) => {
    const backgroundColor = theme === "dark" ? "#20221e" : "#fbfbf9";
    wx.setNavigationBarColor({
      frontColor: theme === "dark" ? "#ffffff" : "#000000",
      backgroundColor,
    });
    wx.setBackgroundColor({ backgroundColor });
    onChange?.(theme);
  };
  const listener = (result: WechatMiniprogram.OnThemeChangeListenerResult) =>
    apply(result.theme);
  apply(wx.getAppBaseInfo().theme || "light");
  wx.onThemeChange(listener);
  return () => wx.offThemeChange(listener);
}
