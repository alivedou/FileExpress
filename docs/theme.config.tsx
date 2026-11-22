import type { DocsThemeConfig } from "nextra-theme-docs";

const config: DocsThemeConfig = {
  logo: <strong>FileExpress Enterprise</strong>,
  project: { link: "https://github.com/alivedou/FileExpress" },
  i18n: [
    { locale: "zh", text: "简体中文" },
    { locale: "en", text: "English" },
  ],
  footer: { text: "FileExpress Enterprise Documentation" },
  sidebar: { defaultMenuCollapseLevel: 1 },
  toc: { backToTop: true },
  search: { placeholder: "搜索文档 / Search documentation" },
  editLink: { text: "编辑此页 / Edit this page" },
};

export default config;
