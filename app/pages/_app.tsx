import { ChakraProvider } from '@chakra-ui/react';
import type { AppProps } from 'next/app';
import Head from 'next/head';
import Layout from '@/src/components/Layout';
import { LanguageProvider } from '@/src/context/LanguageContext';
import { ProfileProvider } from '@/src/context/ProfileContext';
import { AppThemeProvider, useAppTheme } from '@/src/hooks/useMoodTheme';
import { useUpdateChecker } from '@/src/hooks/useUpdateChecker';
import UpdateBanner from '@/src/components/UpdateBanner';
import dynamic from 'next/dynamic';
// Dev-only e2e hook (window.__fewPublishDm); inert in production builds.
import '@/src/lib/dmPublishTestBridge';

// NostrIdentityContext and MarmotContext use heavy crypto packages (NDK, marmot-ts, ts-mls)
// that cannot be processed by Next.js SWC at build time. Load them as client-only imports.
const NostrIdentityProvider = dynamic(
  () => import('@/src/context/NostrIdentityContext').then((m) => ({ default: m.NostrIdentityProvider })),
  { ssr: false }
);

const BackupProvider = dynamic(
  () => import('@/src/context/BackupContext').then((m) => ({ default: m.BackupProvider })),
  { ssr: false }
);

const MarmotProvider = dynamic(
  () => import('@/src/context/MarmotContext').then((m) => ({ default: m.MarmotProvider })),
  { ssr: false }
);

declare global {
  interface Window {
    __BUILD_VERSION?: string;
  }
}

// Expose baked-in build version on window for e2e test introspection.
if (typeof window !== 'undefined') {
  window.__BUILD_VERSION = process.env.NEXT_PUBLIC_BUILD_VERSION;
}

function AppShell({ Component, pageProps }: AppProps) {
  const { activeTheme } = useAppTheme();
  const { updateAvailable } = useUpdateChecker();

  return (
    <ChakraProvider theme={activeTheme}>
      <Head>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <LanguageProvider>
        <ProfileProvider>
          <NostrIdentityProvider>
            <BackupProvider>
              <MarmotProvider>
                <UpdateBanner updateAvailable={updateAvailable} />
                <Layout>
                  <Component {...pageProps} />
                </Layout>
              </MarmotProvider>
            </BackupProvider>
          </NostrIdentityProvider>
        </ProfileProvider>
      </LanguageProvider>
    </ChakraProvider>
  );
}

export default function App(props: AppProps) {
  return (
    <AppThemeProvider>
      <AppShell {...props} />
    </AppThemeProvider>
  );
}
