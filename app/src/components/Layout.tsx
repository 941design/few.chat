import React, { useSyncExternalStore, useState, useCallback } from 'react';
import {
  Box,
  Flex,
  HStack,
  VStack,
  Link,
  Text,
  Container,
  useDisclosure,
  Fade,
  SlideFade,
  IconButton,
} from '@chakra-ui/react';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import { useCopy } from '@/src/context/LanguageContext';
import ProfileSummary from '@/src/components/ProfileSummary';
import { useProfile } from '@/src/context/ProfileContext';
import { useNostrIdentity } from '@/src/context/NostrIdentityContext';
import { useMarmot } from '@/src/context/MarmotContext';
import StorageWarning from '@/src/components/StorageWarning';
import { useThemeStyles } from '@/src/hooks/useThemeStyles';
import { useDynamicBanner } from '@/src/hooks/useDynamicBanner';
import { useAppTheme } from '@/src/hooks/useMoodTheme';
import ThemeIcon from '@/src/components/ThemeIcon';
import { headerIconChipStyle } from '@/src/components/headerIconChip';
import DirectMessageNotificationsWatcher from '@/src/components/DirectMessageNotificationsWatcher';
import PendingPairingIntentWatcher from '@/src/components/PendingPairingIntentWatcher';
import ProfileHealWatcher from '@/src/components/ProfileHealWatcher';
import { IncomingCallWatcher } from '@/src/components/calls/IncomingCallWatcher';
import { IncomingCallModal } from '@/src/components/calls/IncomingCallModal';
import { CallScreen } from '@/src/components/calls/CallScreen';
import { rememberContactsFromGroups } from '@/src/lib/contacts';
import { subscribe as subscribePendingInvitations, getSnapshot as getPendingInvitationsSnapshot } from '@/src/lib/pendingInvitations';
import { useUnreadCounts } from '@/src/lib/unreadStore';
import { contactsDomainTotal, groupsDomainTotal } from '@/src/lib/notificationCounts';

function getPendingInvitationsServerSnapshot() {
  return [] as ReturnType<typeof getPendingInvitationsSnapshot>;
}

/**
 * The imprint footer shows on every page EXCEPT the two open-chat pages: the
 * direct-message thread (`/contacts?id=…`) and the group chat (`/groups?id=…`).
 * On those the message composer sits at the bottom of the viewport and a legal
 * link beneath it reads as chat chrome, so it is dropped there only. The list
 * views for both routes carry no `id` and keep the footer, as does every other
 * page. Keyed on route + presence of `id` (not on whether the contact/group
 * actually resolves), so the decision is a pure function of the URL — testable
 * without mounting the router. `id` may be a string[] for a repeated query
 * param; any non-empty value counts as "a chat is addressed".
 */
export function shouldHideImprintFooter(
  pathname: string,
  id: string | string[] | undefined,
): boolean {
  const hasId = Array.isArray(id) ? id.length > 0 : Boolean(id);
  return hasId && (pathname === '/contacts' || pathname === '/groups');
}

type LayoutProps = {
  children: React.ReactNode;
};

export default function Layout({ children }: LayoutProps) {
  const router = useRouter();
  const { profile } = useProfile();
  const { pubkeyHex, backedUp } = useNostrIdentity();
  const { groups, ready } = useMarmot();
  const copy = useCopy();
  const { isOpen, onToggle } = useDisclosure();
  const { navStyle, surfaceStyle, bannerDecorStyle, contentPanelStyle } = useThemeStyles();
  const { activeThemeDefinition, hydrated } = useAppTheme();
  // Measure the banner box's rendered size the moment it mounts, so the dynamic
  // banner SVG is generated at exactly that size (1:1) rather than an image
  // stretched to fit. For the dynamic-banner theme the box covers the WHOLE
  // header (see the full-cover override below), so this is the header's size.
  // A ref callback (not a mount effect) is used so the measure fires when the
  // box actually appears — i.e. AFTER `hydrated` gates it in below.
  // Regenerate-on-load only: a later window resize is intentionally NOT
  // remeasured (the banner then stretches until the next load).
  const [bannerSize, setBannerSize] = useState<{ width: number; height: number } | undefined>(undefined);
  const measureBanner = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      const r = el.getBoundingClientRect();
      setBannerSize({ width: Math.round(r.width), height: Math.round(r.height) });
    }
  }, []);
  const dynamicBanner = useDynamicBanner(activeThemeDefinition, bannerSize);
  const activeBanner = dynamicBanner ?? bannerDecorStyle;
  // AC-INVITE-8: reactive pending invitation count for Groups nav badge
  const pendingInvitations = useSyncExternalStore(
    subscribePendingInvitations,
    getPendingInvitationsSnapshot,
    getPendingInvitationsServerSnapshot,
  );
  const pendingInvitationCount = pendingInvitations.length;

  // Domain notification totals for the nav pills that replaced the notification
  // bell (epic: obsolete-notification-bell). The Contacts pill sums DM unread +
  // pending contacts; the Groups pill sums group unread + join requests + invite
  // expiries + pending invitations — OIN-1: the received-invitation count merges
  // into the single Groups number rather than staying a separate badge.
  const { counts, joinRequests, directMessages, inviteExpiries, pendingContacts } = useUnreadCounts();
  const navSlices = { counts, joinRequests, directMessages, inviteExpiries, pendingContacts };
  const navBadgeCount = (href: string): number =>
    href === '/groups'
      ? groupsDomainTotal(navSlices, pendingInvitationCount)
      : href === '/contacts'
        ? contactsDomainTotal(navSlices)
        : 0;

  // Hide the imprint footer on the two open-chat pages (see helper above).
  const hideImprintFooter = shouldHideImprintFooter(router.pathname, router.query.id);
  // The mobile bottom tab bar hides on those same open-chat pages: the message
  // composer owns the bottom of the viewport there, so a fixed tab bar would
  // collide with it. Condition is identical to the footer's, reused verbatim.
  const hideBottomNav = hideImprintFooter;

  const navItems = [
    { label: copy.layout.nav.contacts, href: '/contacts', icon: 'contacts' },
    { label: copy.layout.nav.groups, href: '/groups', icon: 'groups' },
  ];

  React.useEffect(() => {
    if (!ready) return;
    rememberContactsFromGroups(groups, pubkeyHex);
  }, [groups, pubkeyHex, ready]);

  return (
    // Flex column + a growing <main> pins the footer to the bottom of the
    // viewport even when the page content is short (sticky-footer pattern).
    <Box
      minH="100vh"
      bg="appBg"
      display="flex"
      flexDirection="column"
      // Clear the fixed mobile bottom bar so the footer / last row of content
      // is never hidden behind it. Only when the bar is shown, and only on
      // mobile (the bar is md:none). Includes the iOS safe-area inset the bar
      // itself also pads by, so the reserved space matches the bar's height.
      sx={
        hideBottomNav
          ? undefined
          : {
              '@media (max-width: 47.99em)': {
                paddingBottom: 'calc(3.5rem + env(safe-area-inset-bottom))',
              },
            }
      }
    >
      <DirectMessageNotificationsWatcher />
      <PendingPairingIntentWatcher />
      <ProfileHealWatcher />
      <IncomingCallWatcher />
      <IncomingCallModal />
      <CallScreen />
      {/* Navigation Bar */}
      <Box
        as="nav"
        bg="surfaceBg"
        borderBottomWidth="1px"
        borderBottomColor="borderSubtle"
        position="sticky"
        top={0}
        zIndex={10}
        aria-label="Main navigation"
        {...navStyle}
      >
        {/* Header-row wrapper — the positioned ancestor the banner decor fills.
            Bounding the banner to THIS box (not the whole <nav>) keeps the
            dynamic-banner art on the header row only; when the mobile hamburger
            expands the <nav>, the banner no longer stretches down behind the
            menu (which then sits on the nav's own opaque surfaceBg). */}
        <Box position="relative">
        {/* Gate on `hydrated`: until the saved theme is read from storage the
            app renders the DEFAULT theme (spring), and rendering its banner here
            would flash the wrong theme's art for a beat before the saved
            theme's banner swaps in. Waiting for hydration means the first
            banner shown is already the correct theme's. */}
        {hydrated && activeBanner && (
          <Box
            ref={measureBanner}
            data-testid="nav-banner-decor"
            {...activeBanner.boxProps}
            {...(dynamicBanner?.hasDynamicBanner
              ? // Dynamic-banner theme: the watercolor is the FULL HEADER
                // background, not the small corner box the static themes use.
                // Override the corner-box geometry to cover the whole nav, and
                // composite with `mix-blend-mode: multiply` so the transparent
                // SVG (no paper of its own) multiplies straight onto the real
                // header background exactly once. The SVG is generated at this
                // box's measured size (Layout measures it here), so it fills
                // 1:1 with no stretch. Static-banner themes keep their corner
                // box untouched (they don't enter this branch).
                {
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  w: '100%',
                  h: '100%',
                  transform: 'none',
                  sx: { mixBlendMode: 'multiply' },
                }
              : {})}
            style={{ transition: 'background-image 0.3s ease-in-out', ...activeBanner.style }}
          />
        )}
        <Container maxW="container.xl" position="relative" zIndex={1}>
          <Flex h={16} align="center" justify="space-between">
            <NextLink href="/" passHref legacyBehavior>
              <Link _hover={{ textDecoration: 'none' }}>
                {/* The wordmark sits on the same permanently-filled chip as the
                    header symbols, so the whole bar reads as one set of controls
                    on the banner art. Opaque, so it fully occludes whatever the
                    banner generator put behind it (AC-A11Y-1's "regardless of
                    the banner content" holds by construction). The text is
                    textStrong, NOT brand.500: brand.500-on-surfaceMutedBg is
                    1.9-3.9:1 in 5 of 7 themes, while textStrong/surfaceMutedBg
                    is a contrast.ts gate pair (>= 4.5:1 in every theme). */}
                <Box
                  data-testid="nav-logo-chip"
                  display="inline-block"
                  bg="surfaceMutedBg"
                  px={2}
                  py={1}
                  borderRadius="md"
                >
                  <Text fontWeight="bold" fontSize="lg" color="textStrong">
                    {copy.appName}
                  </Text>
                </Box>
              </Link>
            </NextLink>

            {/* Desktop nav */}
            <HStack spacing={2} display={{ base: 'none', md: 'flex' }}>
              <HStack as="ul" spacing={2} listStyleType="none">
                {navItems.map((item) => {
                  const isActive = router.pathname === item.href;
                  const badgeCount = navBadgeCount(item.href);
                  const showBadge = badgeCount > 0;
                  const badgeTestId = item.href === '/groups' ? 'groups-nav-badge' : 'contacts-nav-badge';
                  return (
                    <Box as="li" key={item.href}>
                      <NextLink href={item.href} passHref legacyBehavior>
                        <Link
                          aria-label={item.label}
                          {...headerIconChipStyle}
                          color={isActive ? 'brand.500' : 'textMuted'}
                          aria-current={isActive ? 'page' : undefined}
                        >
                          <ThemeIcon name={item.icon} size={20} aria-hidden />
                          {showBadge && (
                            <Box
                              as="span"
                              position="absolute"
                              top="1"
                              right="1"
                              display="inline-flex"
                              alignItems="center"
                              justifyContent="center"
                              bg="orange.500"
                              color="white"
                              fontSize="2xs"
                              fontWeight="bold"
                              lineHeight="1"
                              minW="16px"
                              h="16px"
                              borderRadius="full"
                              px="4px"
                              data-testid={badgeTestId}
                            >
                              {badgeCount > 99 ? '99+' : badgeCount}
                            </Box>
                          )}
                        </Link>
                      </NextLink>
                    </Box>
                  );
                })}
              </HStack>
              <NextLink href="/info" passHref legacyBehavior>
                <Link
                  aria-label={copy.layout.nav.info}
                  {...headerIconChipStyle}
                  color={router.pathname === '/info' ? 'brand.500' : 'textMuted'}
                  data-testid="header-info-link"
                >
                  <ThemeIcon name="info" size={20} aria-hidden />
                </Link>
              </NextLink>
              <NextLink href="/settings" passHref legacyBehavior>
                <Link
                  aria-label={copy.layout.nav.settings}
                  {...headerIconChipStyle}
                  color={router.pathname === '/settings' ? 'brand.500' : 'textMuted'}
                  data-testid="header-settings-link"
                >
                  <ThemeIcon name="settings" size={20} aria-hidden />
                  {!backedUp && (
                    <Box
                      as="span"
                      position="absolute"
                      top="6px"
                      right="6px"
                      w="8px"
                      h="8px"
                      borderRadius="full"
                      bg="orange.400"
                      aria-label={copy.layout.backupNeededLabel}
                      data-testid="gear-backup-dot"
                    />
                  )}
                </Link>
              </NextLink>
              <NextLink href="/profile" passHref legacyBehavior>
                <Link _hover={{ textDecoration: 'none' }}>
                  <Box
                    px={2}
                    py={1}
                    borderWidth="1px"
                    borderRadius="full"
                    borderColor="borderSubtle"
                    bg="surfaceMutedBg"
                    data-testid="header-profile-chip"
                  >
                    <ProfileSummary
                      profile={profile}
                      fallbackName={copy.layout.profileNamePlaceholder}
                      size="sm"
                    />
                  </Box>
                </Link>
              </NextLink>
            </HStack>

            {/* Mobile actions — avatar (leftmost) + hamburger (rightmost);
                Info/Settings live in the dropdown. */}
            <HStack spacing={1} display={{ base: 'flex', md: 'none' }}>
              <NextLink href="/profile" passHref legacyBehavior>
                <Link
                  aria-label={copy.layout.nav.profile}
                  display="inline-flex"
                  alignItems="center"
                  borderRadius="full"
                  _focusVisible={{ boxShadow: 'outline' }}
                  _hover={{ textDecoration: 'none' }}
                  data-testid="mobile-header-profile-avatar"
                >
                  {/* Avatar-only shorthand for the profile — no name, to fit the
                      compact mobile header row. ProfileSummary's avatar is its
                      own bordered circle, so no chip wrapper is needed. The full
                      Profile row (with name) still lives in the dropdown below. */}
                  <ProfileSummary
                    profile={profile}
                    fallbackName={copy.layout.profileNamePlaceholder}
                    size="sm"
                    hideName
                  />
                </Link>
              </NextLink>
              <Box position="relative">
                <IconButton
                  onClick={onToggle}
                  variant="unstyled"
                  {...headerIconChipStyle}
                  color="textMuted"
                  aria-label={copy.layout.mobileMenuLabel}
                  data-testid="mobile-menu-btn"
                  icon={
                    <Text fontSize="xl" lineHeight="1">
                      {isOpen ? '✕' : '☰'}
                    </Text>
                  }
                />
                {!backedUp && !isOpen && (
                  <Box
                    as="span"
                    position="absolute"
                    top="6px"
                    right="6px"
                    w="8px"
                    h="8px"
                    borderRadius="full"
                    bg="orange.400"
                    aria-label={copy.layout.backupNeededLabel}
                    data-testid="mobile-menu-backup-dot"
                    pointerEvents="none"
                  />
                )}
              </Box>
            </HStack>
          </Flex>
          </Container>
        </Box>

        {/* Mobile nav dropdown — OVERLAY. Absolutely positioned just below the
            header so opening it floats OVER the page content instead of pushing
            it down; the content stays in place. Rendered outside the header
            wrapper on its own opaque surfaceBg + shadow, so the banner art never
            bleeds through the menu rows. A tap-scrim (a sibling of <nav>, below)
            dims the content and closes the menu on an outside tap. */}
        <Box
          position="absolute"
          top="100%"
          left={0}
          right={0}
          display={{ base: 'block', md: 'none' }}
          zIndex={1}
          // Clip the slide so the panel appears to emerge from under the header
          // rather than floating in from above it. `pb` leaves room for the
          // panel's drop shadow, which `overflow: hidden` would otherwise crop.
          overflow="hidden"
          pb={2}
        >
          <SlideFade
            in={isOpen}
            offsetY="-100%"
            unmountOnExit
            transition={{ enter: { duration: 0.2 }, exit: { duration: 0.2 } }}
          >
            <Box
              bg="surfaceBg"
              borderBottomWidth="1px"
              borderBottomColor="borderSubtle"
              boxShadow="lg"
            >
              <Container maxW="container.xl">
            <VStack
              as="ul"
              listStyleType="none"
              spacing={0}
              pb={4}
              display={{ base: 'flex', md: 'none' }}
              data-testid="mobile-nav"
            >
              <Box w="100%" px={3} pb={3}>
                <NextLink href="/profile" passHref legacyBehavior>
                  <Link
                    display="block"
                    mb={3}
                    p={3}
                    borderRadius="lg"
                    bg="surfaceMutedBg"
                    data-testid="mobile-header-profile-chip"
                    _hover={{ textDecoration: 'none' }}
                    onClick={onToggle}
                  >
                    <ProfileSummary
                      profile={profile}
                      fallbackName={copy.layout.profileNamePlaceholder}
                      size="sm"
                    />
                  </Link>
                </NextLink>
              </Box>
              {navItems.map((item) => {
                const isActive = router.pathname === item.href;
                const badgeCount = navBadgeCount(item.href);
                const showBadge = badgeCount > 0;
                const badgeTestId = item.href === '/groups' ? 'groups-nav-badge-mobile' : 'contacts-nav-badge-mobile';
                return (
                  <Box as="li" key={item.href} w="100%">
                    <NextLink href={item.href} passHref legacyBehavior>
                      <Link
                        display="flex"
                        alignItems="center"
                        gap={2}
                        py={2}
                        px={3}
                        borderRadius="md"
                        fontWeight={isActive ? 'semibold' : 'normal'}
                        color={isActive ? 'brand.500' : 'textMuted'}
                        bg={isActive ? 'surfaceMutedBg' : 'transparent'}
                        _hover={{ bg: 'surfaceMutedBg', textDecoration: 'none' }}
                        aria-current={isActive ? 'page' : undefined}
                        onClick={onToggle}
                      >
                        <ThemeIcon name={item.icon} size={20} aria-hidden />
                        {item.label}
                        {showBadge && (
                          <Box
                            as="span"
                            display="inline-flex"
                            alignItems="center"
                            justifyContent="center"
                            bg="orange.500"
                            color="white"
                            fontSize="2xs"
                            fontWeight="bold"
                            lineHeight="1"
                            minW="16px"
                            h="16px"
                            borderRadius="full"
                            px="4px"
                            data-testid={badgeTestId}
                          >
                            {badgeCount > 99 ? '99+' : badgeCount}
                          </Box>
                        )}
                      </Link>
                    </NextLink>
                  </Box>
                );
              })}
              {/* Info + Settings also live in the dropdown so it lists every
                  destination, not only the two promoted to the bottom bar. */}
              <Box as="li" key="/info" w="100%">
                <NextLink href="/info" passHref legacyBehavior>
                  <Link
                    display="flex"
                    alignItems="center"
                    gap={2}
                    py={2}
                    px={3}
                    borderRadius="md"
                    fontWeight={router.pathname === '/info' ? 'semibold' : 'normal'}
                    color={router.pathname === '/info' ? 'brand.500' : 'textMuted'}
                    bg={router.pathname === '/info' ? 'surfaceMutedBg' : 'transparent'}
                    _hover={{ bg: 'surfaceMutedBg', textDecoration: 'none' }}
                    aria-current={router.pathname === '/info' ? 'page' : undefined}
                    onClick={onToggle}
                    data-testid="mobile-nav-info-link"
                  >
                    <ThemeIcon name="info" size={20} aria-hidden />
                    {copy.layout.nav.info}
                  </Link>
                </NextLink>
              </Box>
              <Box as="li" key="/settings" w="100%">
                <NextLink href="/settings" passHref legacyBehavior>
                  <Link
                    display="flex"
                    alignItems="center"
                    gap={2}
                    py={2}
                    px={3}
                    borderRadius="md"
                    position="relative"
                    fontWeight={router.pathname === '/settings' ? 'semibold' : 'normal'}
                    color={router.pathname === '/settings' ? 'brand.500' : 'textMuted'}
                    bg={router.pathname === '/settings' ? 'surfaceMutedBg' : 'transparent'}
                    _hover={{ bg: 'surfaceMutedBg', textDecoration: 'none' }}
                    aria-current={router.pathname === '/settings' ? 'page' : undefined}
                    onClick={onToggle}
                    data-testid="mobile-nav-settings-link"
                  >
                    <ThemeIcon name="settings" size={20} aria-hidden />
                    {copy.layout.nav.settings}
                    {!backedUp && (
                      <Box
                        as="span"
                        w="8px"
                        h="8px"
                        borderRadius="full"
                        bg="orange.400"
                        aria-label={copy.layout.backupNeededLabel}
                        data-testid="mobile-nav-settings-backup-dot"
                      />
                    )}
                  </Link>
                </NextLink>
              </Box>
            </VStack>
              </Container>
            </Box>
          </SlideFade>
        </Box>
      </Box>

      {/* Tap-scrim for the mobile nav overlay — a full-viewport backdrop that
          dims the page and closes the menu on an outside tap. Sits below the
          <nav> (zIndex 10, which carries the dropdown) so the header and menu
          stay interactive above it, and above the page content it covers. */}
      {/* Fade (not a bare `isOpen &&`) so the backdrop eases in AND out —
          `unmountOnExit` keeps it in the DOM through the fade-out before it
          leaves, matching the menu's slide timing for a coordinated feel. */}
      <Fade in={isOpen} unmountOnExit transition={{ enter: { duration: 0.2 }, exit: { duration: 0.2 } }}>
        <Box
          display={{ base: 'block', md: 'none' }}
          position="fixed"
          inset={0}
          zIndex={5}
          bg="blackAlpha.500"
          onClick={onToggle}
          data-testid="mobile-nav-scrim"
          aria-hidden
        />
      </Fade>

      {/* Main Content */}
      {contentPanelStyle ? (
        // Dark-background themes (e.g. minecraft) float content on a light
        // GUI panel so dark text tokens stay legible against the backdrop.
        <Container maxW="container.xl" py={8} as="main" flex="1">
          <Box data-testid="content-panel" {...contentPanelStyle} {...surfaceStyle}>
            <StorageWarning />
            {children}
          </Box>
        </Container>
      ) : (
        <Container maxW="container.xl" py={8} as="main" flex="1" {...surfaceStyle}>
          <StorageWarning />
          {children}
        </Container>
      )}

      {/* Mobile bottom tab bar — the two primary domains (Contacts, Groups)
          promoted to a native-feeling fixed bar. Mobile only (hidden at md+,
          where the desktop nav already carries them). Hidden on the open-chat
          pages so it does not collide with the message composer. The header
          hamburger still lists every destination, these two included. */}
      {!hideBottomNav && (
        <Box
          as="nav"
          aria-label={copy.layout.mobileMenuLabel}
          display={{ base: 'flex', md: 'none' }}
          position="fixed"
          bottom={0}
          left={0}
          right={0}
          zIndex={10}
          bg="surfaceBg"
          borderTopWidth="1px"
          borderTopColor="borderSubtle"
          sx={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          data-testid="mobile-bottom-nav"
        >
          <HStack as="ul" listStyleType="none" spacing={0} w="100%">
            {navItems.map((item) => {
              const isActive = router.pathname === item.href;
              const badgeCount = navBadgeCount(item.href);
              const showBadge = badgeCount > 0;
              const badgeTestId = item.href === '/groups' ? 'groups-bottomnav-badge' : 'contacts-bottomnav-badge';
              return (
                <Box as="li" key={item.href} flex="1">
                  <NextLink href={item.href} passHref legacyBehavior>
                    <Link
                      aria-label={item.label}
                      aria-current={isActive ? 'page' : undefined}
                      display="flex"
                      flexDirection="column"
                      alignItems="center"
                      justifyContent="center"
                      gap={0.5}
                      py={2}
                      position="relative"
                      color={isActive ? 'brand.500' : 'textMuted'}
                      _hover={{ color: 'brand.500', textDecoration: 'none' }}
                    >
                      <Box position="relative">
                        <ThemeIcon name={item.icon} size={22} aria-hidden />
                        {showBadge && (
                          <Box
                            as="span"
                            position="absolute"
                            top="-4px"
                            right="-8px"
                            display="inline-flex"
                            alignItems="center"
                            justifyContent="center"
                            bg="orange.500"
                            color="white"
                            fontSize="2xs"
                            fontWeight="bold"
                            lineHeight="1"
                            minW="16px"
                            h="16px"
                            borderRadius="full"
                            px="4px"
                            data-testid={badgeTestId}
                          >
                            {badgeCount > 99 ? '99+' : badgeCount}
                          </Box>
                        )}
                      </Box>
                      <Text fontSize="2xs" fontWeight={isActive ? 'semibold' : 'normal'}>
                        {item.label}
                      </Text>
                    </Link>
                  </NextLink>
                </Box>
              );
            })}
          </HStack>
        </Box>
      )}

      {/* Footer — legal links at the very bottom of every page, except the two
          open-chat pages (DM thread, group chat) where the composer owns the
          bottom of the viewport. */}
      {!hideImprintFooter && (
        <Box as="footer" borderTopWidth="1px" borderTopColor="borderSubtle" py={4}>
          <Container maxW="container.xl">
            <Flex justify="center">
              <NextLink href="/imprint" passHref legacyBehavior>
                <Link
                  fontSize="sm"
                  color="textMuted"
                  _hover={{ color: 'brand.500', textDecoration: 'underline' }}
                  data-testid="footer-imprint-link"
                >
                  {copy.layout.imprintLink}
                </Link>
              </NextLink>
            </Flex>
          </Container>
        </Box>
      )}
    </Box>
  );
}
