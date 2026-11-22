import type { AppProps } from "next/app";

export default function DocumentationApp({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
