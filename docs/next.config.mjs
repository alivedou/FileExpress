import nextra from "nextra";
const withNextra = nextra({ theme: "nextra-theme-docs", themeConfig: "./theme.config.tsx", staticImage: true });
export default withNextra({ output: "export", distDir: ".next", images: { unoptimized: true }, i18n: { locales: ["zh", "en"], defaultLocale: "zh" } });
