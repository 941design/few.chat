import React from 'react';
import {
  Box,
  Button,
  Flex,
  HStack,
  LinkBox,
  LinkOverlay,
  type ButtonProps,
} from '@chakra-ui/react';
import NextLink from 'next/link';
import ProfileSummary from '@/src/components/ProfileSummary';
import type { UserProfile } from '@/src/types';

/**
 * The single card used to present a person across the app — contacts, group
 * members, and pending join requests. Its layout is the contacts-list card:
 * a round avatar + display name on the left (via {@link ProfileSummary}), with
 * status badges and action buttons right-aligned. Callers differ only in which
 * badges/actions they pass and whether the whole card links somewhere.
 *
 * Action buttons must be one of two categories so the affordance reads
 * consistently everywhere: {@link ConfirmButton} for confirming/affirmative
 * actions (Confirm contact, Make admin, Approve) and {@link RejectButton} for
 * rejecting/destructive ones (Cancel invite, Deny, Remove member). Navigation-
 * only affordances (the view-profile icon) stay neutral ghost buttons and are
 * exempt.
 *
 * The two categories are deliberately asymmetric: affirmative actions are
 * filled (solid) so they read as the encouraged path, while negative actions
 * are a danger *outline* — clearly destructive (red) yet visually secondary,
 * so a reject/remove never competes with the affirmative action for the eye.
 * This danger-outline treatment for negative actions is the app-wide standard
 * (see also `BlockContactButton`'s `danger` reject variant).
 */

/** Filled success (green) button — the "confirming / affirmative" action category. */
export function ConfirmButton(props: ButtonProps) {
  return <Button size="sm" variant="solid" colorScheme="success" {...props} />;
}

/** Danger outline (red) button — the "rejecting / destructive" action category. */
export function RejectButton(props: ButtonProps) {
  return <Button size="sm" variant="outline" colorScheme="danger" {...props} />;
}

type UserCardProps = {
  profile: UserProfile;
  /** Display name used when the profile has no nickname (truncated npub, "You", …). */
  fallbackName: string;
  /**
   * When set, the whole card becomes a link to this href (the contacts list
   * opens the direct chat). Only a linked card gets the hover highlight and
   * pointer cursor — a non-linked card (member rows, join-request rows) stays
   * visually static so it never implies a click target it does not have.
   */
  href?: string;
  /** `data-testid` for the card container. */
  cardTestId?: string;
  /** Forwarded to ProfileSummary so per-row test hooks survive (e.g. member-name-*). */
  nameTestId?: string;
  avatarTestId?: string;
  /** Secondary line beneath the name (common groups, npub, …). */
  subline?: React.ReactNode;
  /** Right-aligned cluster: status badges followed by action buttons. */
  actions?: React.ReactNode;
  /** Full-width content below the row (e.g. an inline error alert). */
  footer?: React.ReactNode;
};

export default function UserCard({
  profile,
  fallbackName,
  href,
  cardTestId,
  nameTestId,
  avatarTestId,
  subline,
  actions,
  footer,
}: UserCardProps) {
  const summary = (
    <ProfileSummary
      profile={profile}
      fallbackName={fallbackName}
      size="sm"
      nameTestId={nameTestId}
      avatarTestId={avatarTestId}
    />
  );

  const row = (
    <Flex align="center" gap={3}>
      <Box flex="1" minW={0}>
        {href ? (
          <NextLink href={href} passHref legacyBehavior>
            <LinkOverlay>{summary}</LinkOverlay>
          </NextLink>
        ) : (
          summary
        )}
        {subline}
      </Box>
      {actions ? (
        // position/zIndex keep these controls clickable above LinkOverlay's
        // full-card ::before overlay when the card is a link.
        <HStack
          spacing={2}
          flexShrink={0}
          flexWrap="wrap"
          justify="flex-end"
          position="relative"
          zIndex={1}
        >
          {actions}
        </HStack>
      ) : null}
    </Flex>
  );

  const containerProps = {
    p: 4,
    borderWidth: '1px',
    borderRadius: 'lg',
    borderColor: 'borderSubtle',
    bg: 'surfaceBg',
    'data-testid': cardTestId,
  } as const;

  if (href) {
    return (
      <LinkBox
        as="article"
        {...containerProps}
        cursor="pointer"
        _hover={{ borderColor: 'brand.400', bg: 'surfaceMutedBg' }}
        transition="all 0.15s"
      >
        {row}
        {footer}
      </LinkBox>
    );
  }

  return (
    <Box {...containerProps}>
      {row}
      {footer}
    </Box>
  );
}
