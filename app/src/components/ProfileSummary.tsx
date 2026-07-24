import React from 'react';
import {
  Box,
  HStack,
  Image,
  Text,
  VStack,
} from '@chakra-ui/react';
import type { UserProfile } from '@/src/types';

type ProfileSummaryProps = {
  profile: UserProfile;
  /**
   * Shown as the display name when the profile has no nickname. For the signed-in
   * user this is the localized "You"/"Du" placeholder; for a contact it is the
   * truncated npub.
   */
  fallbackName: string;
  size?: 'sm' | 'md';
  /**
   * Overrides the display-name element's `data-testid`. Defaults to
   * `profile-display-name`. Group member rows pass a per-member id
   * (`member-name-<pubkeyPrefix>`) so their existing test hooks survive the
   * migration onto this shared summary.
   */
  nameTestId?: string;
  /** Overrides the avatar wrapper's `data-testid` (default `profile-avatar-thumb`). */
  avatarTestId?: string;
  /**
   * Render the avatar alone, dropping the display-name element. Used by the
   * mobile header where the avatar is a compact shorthand for the profile and
   * there is no room for the name. `alt` still carries the name for a11y.
   */
  hideName?: boolean;
};

export default function ProfileSummary({
  profile,
  fallbackName,
  size = 'md',
  nameTestId = 'profile-display-name',
  avatarTestId = 'profile-avatar-thumb',
  hideName = false,
}: ProfileSummaryProps) {
  const displayName = profile.nickname || fallbackName;
  const avatarSize = size === 'sm' ? '44px' : '64px';
  const nameSize = size === 'sm' ? 'sm' : 'lg';

  return (
    <HStack spacing={size === 'sm' ? 2 : 4} align="center">
      <Box
        w={avatarSize}
        h={avatarSize}
        borderRadius="full"
        overflow="hidden"
        bg="surfaceMutedBg"
        display="flex"
        alignItems="center"
        justifyContent="center"
        borderWidth="1px"
        borderColor="borderSubtle"
        flexShrink={0}
        data-testid={avatarTestId}
      >
        {profile.avatar ? (
          <Image
            src={profile.avatar.imageUrl}
            alt={displayName}
            w="100%"
            h="100%"
            objectFit="cover"
          />
        ) : (
          <Text fontWeight="bold" color="textMuted" fontSize={size === 'sm' ? 'sm' : 'lg'}>
            {displayName.slice(0, 1).toUpperCase()}
          </Text>
        )}
      </Box>

      {!hideName && (
        <VStack align="start" spacing={0}>
          <Box>
            <Text
              fontWeight="bold"
              fontSize={nameSize}
              data-testid={nameTestId}
            >
              {displayName}
            </Text>
          </Box>
        </VStack>
      )}
    </HStack>
  );
}
