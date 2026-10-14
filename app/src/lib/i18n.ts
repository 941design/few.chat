import type { LanguageCode } from '@/src/types';

export type Copy = {
  appName: string;
  languageNames: Record<LanguageCode, string>;
  layout: {
    nav: {
      contacts: string;
      groups: string;
      settings: string;
      info: string;
      profile: string;
    };
    languageLabel: string;
    mobileMenuLabel: string;
    profileNamePlaceholder: string;
    unreadMessages: (count: number) => string;
    backupNeededLabel: string;
    imprintLink: string;
  };
  // Legal facts live in src/config/imprint.ts; the human-readable labels and
  // section text live in src/content/imprint.*.md. Only the page chrome below
  // stays in i18n.
  imprint: {
    pageTitle: string;
    heading: string;
  };
  // Long-form body lives in src/content/info.*.md; only the page chrome and the
  // collapsible toggle label stay in i18n.
  info: {
    pageTitle: string;
    heading: string;
  };
  home: {
    title: string;
    description: string;
    subheadingLead: string;
    subheadingPoints: string[];
    contactsTitle: string;
    contactsSubtitle: string;
    groupsTitle: string;
    groupsSubtitle: string;
    profileTitle: string;
    profileSubtitle: string;
    howTitle: string;
    howSubtitle: string;
  };
  settings: {
    pageTitle: string;
    heading: string;
    nicknameHeading: string;
    nicknameLimit: (max: number) => string;
    avatarHeading: string;
    changeAvatar: string;
    avatarModalTitle: string;
    fruitNames: Record<string, string>;
    avatarNoResults: string;
    selectedAvatarAlt: string;
    avatarOptionAlt: string;
    languageHeading: string;
    languageDescription: string;
    themeHeading: string;
    themeDescription: string;
    cancel: string;
  };
  storage: {
    title: string;
    description: string;
    dismiss: string;
  };
  identity: {
    npubLabel: string;
    copyNpub: string;
    copiedNpub: string;
    showQr: string;
    qrModalTitle: string;
    qrGenerationError: string;
    backupHeading: string;
    backupDescription: string;
    generatePhrase: string;
    backupWarning: string;
    backupConfirmCheck: string;
    backupDone: string;
    restoreHeading: string;
    restoreDescription: string;
    restoreInput: string;
    restoreButton: string;
    restoreSuccess: string;
    restoreError: string;
    backupNotFound: string;
    backupUnreachable: string;
    backupCheckAgain: string;
    backupUnusable: string;
    backupApplyError: string;
    backupRestoreTitle: string;
    backupRestoreBody: string;
    backupRestoreSkip: string;
    backupRestoreConfirm: string;
    backupReminderTitle: string;
    backupReminderBody: string;
    backupReminderAction: string;
    backupReminderDismiss: string;
    notReady: string;
  };
  groups: {
    pageTitle: string;
    heading: string;
    noGroups: string;
    noGroupsBody: string;
    createGroup: string;
    createGroupTitle: string;
    createGroupNameLabel: string;
    createGroupSubmit: string;
    cancel: string;
    memberCount: (count: number) => string;
    inviteMember: string;
    inviteTitle: string;
    inviteContactLabel: string;
    inviteReasonAlreadyMember: string;
    inviteReasonBlocked: string;
    inviteReasonPendingConfirmation: string;
    inviteGuidanceMessage: string;
    inviteGuidanceLink: string;
    inviteSubmit: string;
    inviteSuccess: string;
    inviteErrorNoKeyPackage: string;
    inviteErrorInvalidNpub: string;
    inviteErrorOffline: string;
    inviteErrorTimeout: string;
    inviteErrorGeneric: string;
    leaveGroup: string;
    leaveGroupTitle: string;
    leaveGroupBody: string;
    leaveGroupConfirm: string;
    abandonGroupTitle: string;
    abandonGroupBody: string;
    abandonGroupConfirm: string;
    loading: string;
    offlineBanner: string;
    offlineLastSync: (time: string) => string;
    syncNow: string;
    fromGroup: (name: string) => string;
    softLimitWarning: string;
    navLabel: string;
    showQr: string;
    scanQr: string;
    qrModalTitle: string;
    qrScannerTitle: string;
    qrScannerHint: string;
    qrStartingCamera: string;
    qrInvalidPayload: string;
    cameraPermissionDenied: string;
    qrUnavailable: string;
    qrGenerationError: string;
    httpsRequired: string;
    httpsRequiredBody: string;
    inviteLinkButton: string;
    inviteLinkTitle: string;
    inviteLinkCopy: string;
    inviteLinkCopied: string;
    inviteLinkCopyError: string;
    inviteLinkLabelField: string;
    inviteLinkLabelPlaceholder: string;
    joinRequestHeading: string;
    joinRequestDescription: string;
    joinRequestNameLabel: string;
    joinRequestNameHelper: string;
    joinRequestNameRequiredHint: string;
    joinRequestButton: string;
    joinRequestSent: string;
    joinRequestError: string;
    joinRequestAlreadyMember: string;
    joinRequestGoToGroup: string;
    pendingRequestsApprove: string;
    pendingRequestsDeny: string;
    pendingRequestsApproveError: string;
    manageLinksButton: string;
    manageLinksTitle: string;
    manageLinksDeactivateLabel: string;
    manageLinksUntitled: string;
    manageLinksCreatedAt: (dateTime: string) => string;
    manageLinksExpiresInHours: (hours: number) => string;
    manageLinksExpiresInMinutes: (minutes: number) => string;
    manageLinksExpiredHoursAgo: (hours: number) => string;
    manageLinksExpiredMinutesAgo: (minutes: number) => string;
    manageLinksExpiredMarker: string;
    manageLinksUsageCount: (count: number) => string;
    manageLinksRemoveButtonLabel: string;
    manageLinksRemoveConfirm: string;
    manageLinksRemoveConfirmButton: string;
    manageLinksEmpty: string;
    membersHeading: string;
    chatHeading: string;
    groupNotFound: string;
    backToGroups: string;
    noMembersYet: string;
    memberPending: string;
    memberRequestedBadge: string;
    memberYou: string;
    cancelInviteButton: string;
    cancelInviteTitle: string;
    cancelInviteBody: string;
    cancelInviteConfirm: string;
    cancelInviteSuccess: string;
    cancelInviteError: string;
    cancelInviteRaceNotice: string;
    cancelInviteAnnouncementWarning: string;
    removeMemberButton: string;
    removeMemberTitle: string;
    removeMemberBody: string;
    removeMemberConfirm: string;
    removeMemberSuccess: string;
    removeMemberError: string;
    cancelledByAnnouncement: (member: string, canceller: string) => string;
    leftGroup: (member: string) => string;
    renameGroupButton: string;
    renameGroupSave: string;
    renameGroupCancel: string;
    renameGroupSuccess: string;
    renameGroupError: string;
    renamedGroupAnnouncement: (actor: string, name: string) => string;
    admittedMemberAnnouncement: (admitter: string, member: string) => string;
    inviteLifecycleInvited: (invitee: string) => string;
    inviteLifecycleAccepted: (invitee: string) => string;
    inviteLifecycleDeclined: (invitee: string) => string;
    makeAdminButton: string;
    makeAdminTitle: string;
    makeAdminBody: string;
    makeAdminConfirm: string;
    makeAdminSuccess: string;
    makeAdminError: string;
    adminBadge: string;
    lastAdminLeaveBlocked: string;
    leavePendingBadge: string;
    removalPendingBadge: string;
    chatLoading: string;
    chatEmpty: string;
    chatPlaceholder: string;
    chatSend: string;
    chatNewMessages: string;
    chatJustNow: string;
    chatMinutesAgo: (minutes: number) => string;
    createGroupError: string;
    /**
     * Epic: group-message-author-auth-app-layer, story S8 (AC-SEND-10) —
     * shown via toast when the INTERACTIVE profile-send path
     * (publishProfileUpdate) cannot produce a forwardable signed inner
     * envelope (locked/absent signer). Background/relay sends never show
     * this — they dev-log only and rely on the existing profile-request
     * retry machinery.
     */
    profileSendFailed: string;
    imageAttachmentLabel: string;
    imageProcessing: string;
    imageUploading: (pct: number) => string;
    imageSendFailed: string;
    imageRetry: string;
    imageDecryptFailed: string;
    imageUnavailable: string;
    imageDownload: string;
    imageTooLarge: string;
    imageRemove: string;
    /**
     * Message edit/delete (epic-feature-request-message-edit-and-delete, S6).
     * Neutral copy only — no "erased"/"deleted for everyone" language and no
     * claim that a non-Few client honors delete/edit as a guarantee
     * (AC-INTEROP-1, AC-INTEROP-2).
     */
    msgEditAction: string;
    msgDeleteAction: string;
    msgEditingBadge: string;
    msgEditSave: string;
    msgEditEmptyHint: string;
    msgDeleteConfirmPrompt: string;
    msgDeleteConfirmButton: string;
    msgEditedMarker: string;
    listPreviewPhoto: string;
    listPreviewEmpty: string;
    listPreviewStructured: string;
    pendingInvitations: {
      badge: string;
      invitedBy: (name: string) => string;
      unknownGroupFallback: string;
      adminLabel: string;
      acceptBtn: string;
      declineBtn: string;
      acceptError: string;
    };
    /**
     * Returning-user invite-link awaiting landing (epic-invite-link-awaiting-landing, S1).
     * GroupsInviteAwaitingCopy seam: consumed by S3 (InviteAwaitingBanner) and S4
     * (OutboundJoinRequestCard). Flat under groups.* per the seam contract's field
     * names — not nested like groups.pendingInvitations. The existing
     * groups.joinRequestButton key ("Request to Join") is reused for the inline
     * action, not duplicated here.
     */
    inviteAwaitingBanner: (groupName: string) => string;
    awaitingApprovalBanner: (groupName: string) => string;
    awaitingBadgeLabel: string;
    cancelOutboundRequestLabel: string;
  };
  contacts: {
    pageTitle: string;
    heading: string;
    emptyTitle: string;
    emptyBody: string;
    listHeading: string;
    hideHiddenOption: string;
    showHiddenOption: (count: number) => string;
    hiddenOnlyBody: (count: number) => string;
    hiddenBadge: string;
    archivedDetailNotice: string;
    /**
     * Epic: block-contact, story S5 (AC-COPY-6) — confirm-dialog copy for the
     * block-confirmation modal (S4 wires `Modal` + `useDisclosure`, mirroring
     * `LeaveGroupButton`'s destructive-action pattern). The body MUST warn
     * that blocking deletes the conversation history and blocks the person.
     */
    blockConfirmTitle: string;
    blockConfirmBody: string;
    blockConfirmButton: string;
    blockCancelButton: string;
    profileNameFallback: string;
    backToContacts: string;
    contactNotFound: string;
    commonGroups: (names: string[]) => string;
    // addContact* success/error copy is retained for the /add contact-card
    // deep-link page (the manual "add by npub" modal was removed).
    addContactSuccess: string;
    /**
     * Epic: contact-pairing-code, story S4/AC-SCAN-4 — shown instead of
     * `addContactSuccess` when the add carried a pairing-ack echo (`?pairing=
     * sent|pending`, see contacts.tsx). MUST communicate reciprocation is in
     * flight, MUST NOT claim a mutual/"connected" state (no ack-of-ack
     * exists). Placeholder text wired by S4; final copy owned by S5.
     */
    addContactPairingInFlight: string;
    addContactErrorInvalidNpub: string;
    addContactErrorSelf: string;
    addContactErrorAlreadyExists: string;
    addContactErrorGeneric: string;
    /**
     * Epic: contact-pairing-code, story S5 (AC-UI-3, RD-5) — shown instead of
     * `addContactErrorInvalidNpub` when the import specifically failed
     * because the card's header encodes a version this build's codec does
     * not recognize (`contactCard.ts#decodeCard`'s AC-CODEC-4 rejection,
     * surfaced via `processContactInput.ts`'s `unsupported_version` error
     * code). MUST read as "your app is out of date", not "your input is
     * wrong" — the two are different problems with different fixes.
     */
    addContactErrorUnsupportedVersion: string;
    /**
     * Epic: contact-pairing-code, story S5 (AC-UI-2) — the single digest
     * notification shown when 2+ distinct senders have echoed a pairing-ack
     * for the issuer's currently-active nonce, replacing one toast per
     * admission. `count` is always >= 2 at the call site.
     */
    pairingAdmissionDigest: (count: number) => string;
    /**
     * Epic: pending-contact-confirmation, story S2 (AC-UX-1/2/3). A pending
     * contact — one who scanned the local user's contact card but has not yet
     * been explicitly confirmed — is visibly distinct from the existing
     * `hiddenBadge` (blocked) indicator, per Design Decision 9's
     * "blocked always wins over pending" precedence.
     */
    pendingBadge: string;
    /** Confirmation-prompt heading shown in place of the chat thread while pending. */
    pendingConfirmHeading: string;
    /** Confirmation-prompt body, naming the pending contact. */
    pendingConfirmBody: (name: string) => string;
    /** Confirm action label, reused by both the contacts-list row and the detail-view prompt. */
    pendingConfirmButton: string;
    /**
     * Reject action label on the detail-view pending-confirmation prompt — the
     * first-class negative counterpart to Confirm, mirroring the group join-
     * request `[Approve] [Deny]` layout. Backed by the existing block/archive
     * flow (spec.md Non-Goals — reject IS block, there is no separate
     * mechanism), so clicking it opens the standard block confirm modal, which
     * still explains the real consequences before anything is actioned. Passed
     * to `BlockContactButton`'s `label` prop; the button's other call sites
     * (profile page, Blocked banner) keep their own "Block contact" label.
     */
    pendingRejectButton: string;
  };
  /**
   * `/add#c=…` static deep-link/onboarding page (epic: contact-card-exchange,
   * story S7). A successful add is not shown here — the page redirects to the
   * selected contact and the contacts page renders the green confirmation
   * (`contacts.addContactSuccess`). The error copy for a failed add is
   * intentionally reused from `contacts.addContactError*` rather than
   * duplicated here — same outcome, same wording.
   */
  add: {
    pageTitle: string;
    heading: string;
    settingUp: string;
    redirecting: string;
    noCard: string;
    goToContacts: string;
  };
  /**
   * Epic: first-visit-invite-welcome, story S2 — the shared WelcomeInvite
   * presentation component (contact-card and group-invite variants, wired by
   * S3/S4). The pitch itself is NOT duplicated here — it reuses
   * home.subheadingLead / home.subheadingPoints. contactInviteLine /
   * groupInviteLine are the two dynamic invite-line variants; the group
   * primary action reuses groups.joinRequestButton ("Request to Join")
   * rather than a new welcome.* key, since that copy already says the right
   * thing for both call sites.
   */
  welcome: {
    contactInviteLine: (name: string) => string;
    groupInviteLine: (group: string) => string;
    nameLabel: string;
    namePlaceholder: string;
    contactPrimaryAction: string;
  };
  profile: {
    pageTitle: string;
    backLabel: string;
    copyNpub: string;
    copiedNpub: string;
    shareCardHeading: string;
    shareCardDescription: string;
    shareCardButton: string;
    shareCardNeedsName: string;
    shareCardNeedsNameContacts: string;
    shareCardNeedsNameContactsLink: string;
    shareCardTitle: string;
    copyCardLink: string;
    copiedCardLink: string;
    shareCardError: string;
    sendDm: string;
    archiveAction: string;
    unarchiveAction: string;
    blockedNotice: string;
    viewProfile: string;
    notFound: string;
    addToGroupLabel: string;
    addToGroupSelect: string;
    addToGroupBtn: string;
    addToGroupSuccess: string;
    addToGroupError: string;
    ownHeading: string;
    ownDescription: string;
    backupNeededHint: string;
    /**
     * Epic: contact-pairing-code, story S4/RD-7 — shown on `/profile?pairing=1`,
     * the name-setup redirect a nameless scanner lands on after opening a live
     * pairing code (AC-SCAN-5). Placeholder text wired by S4; final copy owned
     * by S5 (stories.json: "the scanner-side honesty-copy and name-setup-
     * redirect-prompt strings that S4 wires by key").
     */
    pairingNameSetupPrompt: string;
    /**
     * Epic: contact-pairing-code, story S5 (AC-UI-1) — shown inside
     * `NpubQrModal.tsx` under the QR/code block whenever a share card
     * (`shareUrl`-encoded) is rendered, so the ~30-minute validity window is
     * legible even from a screenshot of just the modal, not only from the
     * profile page's surrounding description text.
     */
    shareCardValidityHint: string;
  };
  polls: {
    heading: (count: number) => string;
    noPolls: string;
    createPoll: string;
    pollButton: string;
    singleChoice: string;
    multipleChoice: string;
    vote: string;
    updateVote: string;
    voted: string;
    voteCount: (count: number) => string;
    voterCount: (count: number) => string;
    closePoll: string;
    closeConfirm: string;
    confirm: string;
    cancel: string;
    closed: string;
    pollLabel: string;
    pollResultsLabel: string;
    startedPoll: (name: string) => string;
    closedPoll: (name: string) => string;
    questionLabel: string;
    questionPlaceholder: string;
    descriptionLabel: string;
    descriptionPlaceholder: string;
    optionsLabel: string;
    optionPlaceholder: (letter: string) => string;
    addOption: string;
    pollTypeLabel: string;
    createError: string;
  };
  emoji: {
    openPicker: string;
    closePicker: string;
    reactWith: string;
    insertEmoji: string;
    removeReaction: string;
    reactors: string;
    reactionCount: string;
  };
  updateBanner: {
    message: string;
    reload: string;
    dismissAriaLabel: string;
  };
  feedback: {
    settingsRowLabel: string;
    pageTitle: string;
    encryptedSubtitle: string;
    composerPlaceholder: string;
    unavailableState: string;
  };
  advanced: {
    sectionTitle: string;
    toggleExpand: string;
    toggleCollapse: string;
    relays: {
      sectionTitle: string;
      addPlaceholder: string;
      addBtn: string;
      removeBtn: string;
      resetBtn: string;
      saveBtn: string;
      savedSuccess: string;
      statusConnected: string;
      statusConnecting: string;
      statusDisconnected: string;
      lastRelayError: string;
      invalidUrlError: string;
      duplicateUrlError: string;
      discoverabilityNote: string;
    };
    dangerZone: {
      title: string;
      wipeBtn: string;
      wipeConfirmPrompt: string;
      wipeConfirmBtn: string;
      wipeConfirmWord: string;
      wipeCancel: string;
      wipeWarning: string;
    };
    nip46: {
      sectionTitle: string;
      description: string;
      disclosureGroupFast: string;
      disclosureIdentityLeaves: string;
      disclosureDmSlow: string;
      connectQrBtn: string;
      connectPasteBtn: string;
      relayInputLabel: string;
      relayInputPlaceholder: string;
      generateQrBtn: string;
      confirmConnectBtn: string;
      pasteUriLabel: string;
      pasteUriPlaceholder: string;
      connectBtn: string;
      connecting: string;
      connected: string;
      connectedAs: string;
      reconnecting: string;
      disconnect: string;
      signerUnavailable: string;
      retryBtn: string;
      errorUnreachable: string;
      authChallengeOpened: string;
    };
    nip07: {
      sectionTitle: string;
      description: string;
      connectBtn: string;
      connecting: string;
      connected: string;
      connectedAs: string;
      disconnect: string;
      noExtensionError: string;
      nip44MissingError: string;
      reconnectError: string;
    };
  };
  calls: {
    incomingCallTitle: string;
    incomingVoiceCall: string;
    incomingVideoCall: string;
    acceptCall: string;
    declineCall: string;
    muteAudio: string;
    unmuteAudio: string;
    cameraOff: string;
    cameraOn: string;
    hangUp: string;
    participants: (count: number) => string;
    callConnected: string;
    startVoiceCall: string;
    startVideoCall: string;
    callDisabledGroupFull: string;
    callInProgress: string;
    callSettings: string;
    turnServerUrl: string;
    turnUsername: string;
    turnCredential: string;
    saveTurnConfig: string;
    ipPrivacyMode: string;
    turnHelp: string;
    ipPrivacyHelp: string;
    callStartedNotice: (callerName: string) => string;
    callEndedNotice: string;
  };
  scanner: {
    fabAriaLabel: string;
    tabLabel: string;
    title: string;
    startingCamera: string;
    permissionDenied: string;
    unavailable: string;
    unrecognisedLink: string;
  };
};

export function normalizeLanguage(input?: string | null): LanguageCode {
  // When no language can be detected, default to German.
  if (!input) return 'de';
  return input.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export function detectBrowserLanguage(): LanguageCode {
  // No navigator (e.g. SSR / static export) means no language to detect → German.
  if (typeof navigator === 'undefined') return 'de';
  return normalizeLanguage(navigator.language);
}

const copy: Record<LanguageCode, Copy> = {
  en: {
    appName: 'few.chat',
    languageNames: { en: 'English', de: 'Deutsch' },
    layout: {
      nav: {
        contacts: 'Contacts',
        groups: 'Groups',
        settings: 'Settings',
        info: 'How few.chat works',
        profile: 'Profile',
      },
      languageLabel: 'Language',
      mobileMenuLabel: 'Toggle navigation menu',
      profileNamePlaceholder: 'You',
      unreadMessages: (count: number) => count === 1 ? '1 new message' : `${count} new messages`,
      backupNeededLabel: 'Backup needed',
      imprintLink: 'Imprint',
    },
    imprint: {
      pageTitle: 'Imprint',
      heading: 'Imprint',
    },
    info: {
      pageTitle: 'How it works',
      heading: 'How few.chat works',
    },
    home: {
      title: 'Welcome to few.chat',
      description:
        'Private, end-to-end encrypted chats. Message your contacts directly or talk together in groups.',
      subheadingLead: 'Just chat.',
      subheadingPoints: [
        'No email address required',
        'No login or password to remember',
        'No phone number needed',
        'No messages from strangers',
        'Completely free',
      ],
      contactsTitle: 'Contacts',
      contactsSubtitle: 'Message the people you know directly.',
      groupsTitle: 'Groups',
      groupsSubtitle: 'Chat together in groups.',
      profileTitle: 'Profile',
      profileSubtitle: 'Manage your name and avatar.',
      howTitle: 'How few.chat works',
      howSubtitle: 'A quick look at what makes it private.',
    },
    settings: {
      pageTitle: 'Settings',
      heading: 'Settings',
      nicknameHeading: 'Name',
      nicknameLimit: (max: number) => `Name reached the ${max}-character limit (accented letters and emoji count for more).`,
      avatarHeading: 'Avatar',
      changeAvatar: 'Change Avatar',
      avatarModalTitle: 'Choose Your Avatar',
      fruitNames: {
        apple: 'Apple',
        apricot: 'Apricot',
        avocado: 'Avocado',
        banana: 'Banana',
        'bell pepper': 'Bell Pepper',
        blackberry: 'Blackberry',
        blueberry: 'Blueberry',
        'bok choy': 'Bok Choy',
        broccoli: 'Broccoli',
        'butternut squash': 'Butternut Squash',
        cactus: 'Cactus',
        carrot: 'Carrot',
        celery: 'Celery',
        cherry: 'Cherry',
        'chili pepper': 'Chili Pepper',
        clementine: 'Clementine',
        coconut: 'Coconut',
        corn: 'Corn',
        cranberry: 'Cranberry',
        cucumber: 'Cucumber',
        durian: 'Durian',
        edamame: 'Edamame',
        eggplant: 'Eggplant',
        fig: 'Fig',
        garlic: 'Garlic',
        'goji berry': 'Goji Berry',
        grapefruit: 'Grapefruit',
        'green bean': 'Green Bean',
        guava: 'Guava',
        jalapeno: 'Jalapeño',
        kale: 'Kale',
        'kiwi fruit': 'Kiwi Fruit',
        lemon: 'Lemon',
        lettuce: 'Lettuce',
        lime: 'Lime',
        mango: 'Mango',
        mushroom: 'Mushroom',
        papaya: 'Papaya',
        parsnip: 'Parsnip',
        peanut: 'Peanut',
        pear: 'Pear',
        pineapple: 'Pineapple',
        plantain: 'Plantain',
        plum: 'Plum',
        pomegranate: 'Pomegranate',
        potato: 'Potato',
        radish: 'Radish',
        raspberry: 'Raspberry',
        strawberry: 'Strawberry',
        'sweet potato': 'Sweet Potato',
        tangerine: 'Tangerine',
        tomato: 'Tomato',
        turnip: 'Turnip',
        watermelon: 'Watermelon',
        zucchini: 'Zucchini',
      },
      avatarNoResults: 'No avatars for this fruit yet. Try another.',
      selectedAvatarAlt: 'Selected avatar',
      avatarOptionAlt: 'Avatar option',
      languageHeading: 'Language',
      languageDescription: 'Choose which language the app should use.',
      themeHeading: 'Theme',
      themeDescription: 'Choose the visual theme for the app.',
      cancel: 'Cancel',
    },
    storage: {
      title: 'Storage Unavailable',
      description:
        "Your browser's local storage is not available (private mode?). The app will work, but your settings won't be saved between sessions.",
      dismiss: 'Dismiss warning',
    },
    identity: {
      npubLabel: 'Your public key (npub)',
      copyNpub: 'Copy npub',
      copiedNpub: 'Copied!',
      showQr: 'Show QR',
      qrModalTitle: 'Npub QR Code',
      qrGenerationError: 'Failed to generate QR code.',
      backupHeading: 'Back Up Your Identity',
      backupDescription:
        'Generate a recovery phrase to restore your identity if you clear browser data.',
      generatePhrase: 'Generate Backup Phrase',
      backupWarning:
        'Write down these 12 words in order and keep them safe. They cannot be recovered if lost.',
      backupConfirmCheck: 'I have written down my recovery phrase',
      backupDone: 'Identity backed up successfully.',
      restoreHeading: 'Restore from Backup',
      restoreDescription: 'Enter your 12-word recovery phrase to restore your identity.',
      restoreInput: 'Enter recovery phrase...',
      restoreButton: 'Restore Identity',
      restoreSuccess: 'Identity restored successfully.',
      restoreError: 'Invalid recovery phrase. Please check the words and try again.',
      backupNotFound: 'No backup of your app state was found. Only your identity was restored.',
      backupUnreachable: "Couldn't reach the relays to check for a backup of your app state.",
      backupCheckAgain: 'Check again',
      backupUnusable: "A backup was found, but this version of the app can't use it. Update the app and restore again.",
      backupApplyError: 'Your identity was restored, but applying the backup failed.',
      backupRestoreTitle: 'Restore from backup?',
      backupRestoreBody:
        'A backup of your groups and settings was found. Restoring adds it to this device; nothing on this device is deleted.',
      backupRestoreSkip: 'Skip',
      backupRestoreConfirm: 'Restore',
      backupReminderTitle: 'Back up your identity',
      backupReminderBody:
        "You are in a group but haven't backed up your identity. If you clear browser data, you will lose access.",
      backupReminderAction: 'Back up now',
      backupReminderDismiss: 'Dismiss',
      notReady: 'Identity not ready yet',
    },
    groups: {
      pageTitle: 'Groups',
      heading: 'Groups',
      noGroups: 'You are not in any groups yet.',
      noGroupsBody: 'Create a group or wait for an invitation from a friend.',
      createGroup: 'Create Group',
      createGroupTitle: 'Create Group',
      createGroupNameLabel: 'Group Name',
      createGroupSubmit: 'Create Group',
      cancel: 'Cancel',
      memberCount: (count) => `${count} member${count !== 1 ? 's' : ''}`,
      inviteMember: 'Invite Member',
      inviteTitle: 'Invite a contact',
      inviteContactLabel: 'Choose a contact',
      inviteReasonAlreadyMember: 'already in group',
      inviteReasonBlocked: 'blocked',
      inviteReasonPendingConfirmation: 'not yet confirmed',
      inviteGuidanceMessage: 'No contacts available to invite. Add contacts by sharing your profile card from the Contacts page.',
      inviteGuidanceLink: 'Go to Contacts',
      inviteSubmit: 'Send Invite',
      inviteSuccess: 'Invitation sent successfully.',
      inviteErrorNoKeyPackage: 'This user has not set up their Few identity yet.',
      inviteErrorInvalidNpub: 'Invalid npub format.',
      inviteErrorOffline: 'You are offline. Please connect to invite members.',
      inviteErrorTimeout: 'Relay timed out. Please try again.',
      inviteErrorGeneric: 'Failed to send invitation. Please try again.',
      leaveGroup: 'Leave Group',
      leaveGroupTitle: 'Leave Group?',
      leaveGroupBody: 'You will lose access to this group and its messages.',
      leaveGroupConfirm: 'Leave Group',
      abandonGroupTitle: 'Abandon Group?',
      abandonGroupBody: 'You are the last member. Leaving deletes this group permanently. It cannot be recovered.',
      abandonGroupConfirm: 'Abandon Group',
      loading: 'Loading...',
      offlineBanner: 'Offline — group sync unavailable',
      offlineLastSync: (time) => `Last synced: ${time}`,
      syncNow: 'Sync now',
      fromGroup: (name) => `From group: ${name}`,
      softLimitWarning: 'This group is near the recommended limit of 50 members.',
      navLabel: 'Groups',
      showQr: 'Show QR code',
      scanQr: 'Scan QR code',
      qrModalTitle: 'Npub QR Code',
      qrScannerTitle: 'Scan Npub QR Code',
      qrScannerHint: 'Point the camera at a QR code containing an npub.',
      qrStartingCamera: 'Starting camera...',
      qrInvalidPayload: 'This QR code does not contain a valid npub.',
      cameraPermissionDenied: 'Camera permission was denied.',
      qrUnavailable: 'QR scanning is unavailable on this device or browser.',
      qrGenerationError: 'Failed to generate QR code.',
      httpsRequired: 'HTTPS required',
      httpsRequiredBody: 'Encrypted groups require a secure connection (HTTPS). Please access this site over HTTPS to use groups.',
      inviteLinkButton: 'Invite Link',
      inviteLinkTitle: 'Generate Invite Link',
      inviteLinkCopy: 'Copy Link',
      inviteLinkCopied: 'Link copied to clipboard',
      inviteLinkCopyError: 'Failed to copy link',
      inviteLinkLabelField: 'Label (optional)',
      inviteLinkLabelPlaceholder: 'e.g. Sent to class chat',
      joinRequestHeading: "You've been invited to join a group",
      joinRequestDescription: 'Send a join request to the group admin?',
      joinRequestNameLabel: 'Your name',
      joinRequestNameHelper: 'The group admin will see this name on your join request.',
      joinRequestNameRequiredHint: 'Enter a name to continue',
      joinRequestButton: 'Request to Join',
      joinRequestSent: "Request sent! You'll be added once the admin approves.",
      joinRequestError: 'Failed to send join request. Please try again.',
      joinRequestAlreadyMember: "You're already a member of this group.",
      joinRequestGoToGroup: 'Go to group',
      pendingRequestsApprove: 'Approve',
      pendingRequestsDeny: 'Deny',
      pendingRequestsApproveError: 'Failed to approve request. Please try again.',
      manageLinksButton: 'Manage Links',
      manageLinksTitle: 'Manage Invite Links',
      manageLinksDeactivateLabel: 'Deactivated',
      manageLinksUntitled: 'Untitled',
      manageLinksCreatedAt: (dateTime: string) => `Created ${dateTime}`,
      manageLinksExpiresInHours: (hours: number) => hours === 1 ? 'Expires in 1 h' : `Expires in ${hours} h`,
      manageLinksExpiresInMinutes: (minutes: number) => minutes === 1 ? 'Expires in 1 min' : `Expires in ${minutes} min`,
      manageLinksExpiredHoursAgo: (hours: number) => hours === 1 ? 'Expired 1 h ago' : `Expired ${hours} h ago`,
      manageLinksExpiredMinutesAgo: (minutes: number) => minutes === 1 ? 'Expired 1 min ago' : `Expired ${minutes} min ago`,
      manageLinksExpiredMarker: 'Expired',
      manageLinksUsageCount: (count: number) => count === 1 ? '1 joined via this link' : `${count} joined via this link`,
      manageLinksRemoveButtonLabel: 'Remove link',
      manageLinksRemoveConfirm: 'Remove this link?',
      manageLinksRemoveConfirmButton: 'Remove',
      manageLinksEmpty: 'No invite links yet.',
      membersHeading: 'Members',
      chatHeading: 'Chat',
      groupNotFound: 'Group not found.',
      backToGroups: 'Back to Groups',
      noMembersYet: 'No members yet.',
      memberPending: 'Pending',
      memberRequestedBadge: 'Requested to join',
      memberYou: 'You',
      cancelInviteButton: 'Cancel Invite',
      cancelInviteTitle: 'Cancel Pending Invitation',
      cancelInviteBody: 'Cancel this pending invitation? They will be removed from the group permanently.',
      cancelInviteConfirm: 'Confirm',
      cancelInviteSuccess: 'Invitation cancelled',
      cancelInviteError: 'Failed to cancel invitation',
      cancelInviteRaceNotice: 'This invitation is no longer pending',
      cancelInviteAnnouncementWarning: 'Invitation cancelled, but the group chat could not be notified',
      removeMemberButton: 'Remove Member',
      removeMemberTitle: 'Remove Member',
      removeMemberBody:
        'Remove this member from the group? They will lose access to the group and its messages.',
      removeMemberConfirm: 'Remove',
      removeMemberSuccess: 'Member removed',
      removeMemberError: 'Failed to remove member',
      cancelledByAnnouncement: (member: string, canceller: string) => `${member} was uninvited by ${canceller}`,
      leftGroup: (member: string) => `${member} left the group`,
      renameGroupButton: 'Rename group',
      renameGroupSave: 'Save name',
      renameGroupCancel: 'Cancel rename',
      renameGroupSuccess: 'Group renamed',
      renameGroupError: 'Failed to rename group. Please try again.',
      renamedGroupAnnouncement: (actor: string, name: string) => `${actor} renamed the group to “${name}”`,
      admittedMemberAnnouncement: (admitter: string, member: string) => `${admitter} admitted ${member}`,
      inviteLifecycleInvited: (invitee: string) => `${invitee} was invited`,
      inviteLifecycleAccepted: (invitee: string) => `${invitee} joined the group`,
      inviteLifecycleDeclined: (invitee: string) => `${invitee} declined the invitation`,
      makeAdminButton: 'Make Admin',
      makeAdminTitle: 'Make Admin?',
      makeAdminBody: 'This cannot be undone. Admins can invite members, accept join requests, cancel invitations, and grant admin to others.',
      makeAdminConfirm: 'Make Admin',
      makeAdminSuccess: 'Admin granted',
      makeAdminError: 'Failed to grant admin. Please try again.',
      adminBadge: 'Admin',
      lastAdminLeaveBlocked: 'You are the only admin. Grant admin to another member before leaving.',
      leavePendingBadge: 'Departed, cleanup pending',
      // removalPendingBadge is reserved for a future cause-distinction increment (S6 decision:
      // PendingRemoval carries no cause field, so all pending removals use leavePendingBadge today).
      removalPendingBadge: 'Removal pending',
      chatLoading: 'Loading messages...',
      chatEmpty: 'No messages yet. Say hello!',
      chatPlaceholder: 'Type a message...',
      chatSend: 'Send message',
      chatNewMessages: 'New messages',
      chatJustNow: 'just now',
      chatMinutesAgo: (minutes: number) => `${minutes}m ago`,
      createGroupError: 'Failed to create group. Please try again.',
      profileSendFailed: "Couldn't send your profile — your signer is locked or unavailable.",
      imageAttachmentLabel: 'Attach image',
      imageProcessing: 'Processing image…',
      imageUploading: (pct: number) => `Uploading ${pct}%`,
      imageSendFailed: 'Failed to send image',
      imageRetry: 'Retry',
      imageDecryptFailed: "Couldn't decrypt this image",
      imageUnavailable: 'Image is no longer available',
      imageDownload: 'Download',
      imageTooLarge: 'Image is too large',
      imageRemove: 'Remove image',
      msgEditAction: 'Edit',
      msgDeleteAction: 'Delete',
      msgEditingBadge: 'Editing message',
      msgEditSave: 'Save edit',
      msgEditEmptyHint: "A message can't be empty — delete it instead.",
      msgDeleteConfirmPrompt: 'Delete this message?',
      msgDeleteConfirmButton: 'Yes, delete',
      msgEditedMarker: '(edited)',
      listPreviewPhoto: 'Photo',
      listPreviewEmpty: 'No messages yet',
      listPreviewStructured: 'New activity',
      pendingInvitations: {
        badge: 'Invitation',
        invitedBy: (name: string) => `Invited by ${name}`,
        unknownGroupFallback: 'Group invitation',
        adminLabel: 'Group admins',
        acceptBtn: 'Accept',
        declineBtn: 'Decline',
        acceptError: 'This invitation is no longer valid',
      },
      inviteAwaitingBanner: (groupName: string) => `You've been invited to join ${groupName}.`,
      awaitingApprovalBanner: (groupName: string) => `Waiting for the admin to approve your request to join ${groupName}.`,
      awaitingBadgeLabel: 'Awaiting',
      cancelOutboundRequestLabel: 'Cancel Request',
    },
    contacts: {
      pageTitle: 'Contacts',
      heading: 'Contacts',
      emptyTitle: 'No contacts yet',
      emptyBody: 'Join a group with someone, or open a contact card link they share with you, and they will appear here.',
      listHeading: 'All contacts',
      hideHiddenOption: 'Hide blocked contacts',
      showHiddenOption: (count: number) => count === 0 ? 'Show blocked contacts' : `Show blocked contacts (${count})`,
      hiddenOnlyBody: (count: number) => count === 1 ? '1 blocked contact is currently filtered out.' : `${count} blocked contacts are currently filtered out.`,
      hiddenBadge: 'Blocked',
      archivedDetailNotice: 'You have blocked this contact. Their messages are filtered and your conversation history was deleted.',
      blockConfirmTitle: 'Block contact?',
      blockConfirmBody: 'Blocking this contact deletes your conversation history and stops them from messaging you. This cannot be undone.',
      blockConfirmButton: 'Block contact',
      blockCancelButton: 'Cancel',
      profileNameFallback: 'Unnamed contact',
      backToContacts: 'Back to Contacts',
      contactNotFound: 'Contact not found.',
      commonGroups: (names: string[]) => `Groups: ${names.join(', ')}`,
      addContactSuccess: 'Contact added',
      addContactPairingInFlight: 'Contact added — they should see you shortly.',
      addContactErrorInvalidNpub: "That doesn't look like a valid npub. Please check and try again.",
      addContactErrorSelf: "You can't add yourself as a contact.",
      addContactErrorAlreadyExists: 'This person is already in your contacts.',
      addContactErrorGeneric: "Couldn't add this contact. Please try again.",
      addContactErrorUnsupportedVersion: 'This contact card needs a newer version of the app. Please update and try again.',
      pairingAdmissionDigest: (count: number) => `${count} people paired with your code`,
      pendingBadge: 'Pending',
      pendingConfirmHeading: 'Confirm this contact?',
      pendingConfirmBody: (name: string) => `${name} scanned your contact card. Their messages are held until you confirm you recognize them.`,
      pendingConfirmButton: 'Confirm contact',
      pendingRejectButton: 'Reject',
    },
    add: {
      pageTitle: 'Add Contact',
      heading: 'Add Contact',
      settingUp: 'Setting up your account…',
      redirecting: 'Opening your new contact…',
      noCard: "This link doesn't include a contact card.",
      goToContacts: 'Go to Contacts',
    },
    welcome: {
      contactInviteLine: (name: string) => `${name} invited you to few.chat`,
      groupInviteLine: (group: string) => `You're invited to join ${group}`,
      nameLabel: 'Your name',
      namePlaceholder: 'You',
      contactPrimaryAction: 'Get started',
    },
    profile: {
      pageTitle: 'Profile',
      backLabel: 'Back',
      copyNpub: 'Copy',
      copiedNpub: 'Copied!',
      shareCardHeading: 'Share your contact card',
      shareCardDescription:
        'Share a signed link that adds you by name — no relay, no public profile broadcast. It stays valid for about 30 minutes, so share it while you can both be online. Others open it or scan the QR to add you.',
      shareCardValidityHint: 'This code works for about 30 minutes.',
      shareCardButton: 'Share contact card',
      shareCardNeedsName: 'Set a name above before you can share your contact card.',
      shareCardNeedsNameContacts: 'Set a name on your profile before you can share your contact card.',
      shareCardNeedsNameContactsLink: 'Go to your profile',
      shareCardTitle: 'Share Contact Card',
      copyCardLink: 'Copy card link',
      copiedCardLink: 'Copied!',
      shareCardError: 'Failed to build the share card. Please try again.',
      sendDm: 'Send message',
      archiveAction: 'Block contact',
      unarchiveAction: 'Unblock contact',
      blockedNotice: "You've blocked this contact. Unblock them to send messages or add them to a group.",
      viewProfile: 'View profile',
      notFound: 'Profile not found.',
      addToGroupLabel: 'Add to a group',
      addToGroupSelect: 'Choose a group',
      addToGroupBtn: 'Add to group',
      addToGroupSuccess: 'Contact added to the group.',
      addToGroupError: 'Could not add the contact to the group. Please try again.',
      ownHeading: 'My Profile',
      ownDescription: 'This is how others see you.',
      backupNeededHint: 'Your identity is not backed up yet. Go to Settings to back it up.',
      pairingNameSetupPrompt: 'Set a name so they know you added them back.',
    },
    polls: {
      heading: (count: number) => count > 0 ? `Polls (${count})` : 'Polls',
      noPolls: 'No polls yet',
      createPoll: 'Create Poll',
      pollButton: 'new survey',
      singleChoice: 'Single choice',
      multipleChoice: 'Multiple choice',
      vote: 'Vote',
      updateVote: 'Update Vote',
      voted: 'Voted',
      voteCount: (count: number) => count === 1 ? '1 vote' : `${count} votes`,
      voterCount: (count: number) => count === 1 ? '1 voter' : `${count} voters`,
      closePoll: 'Close Poll',
      closeConfirm: 'Close this poll? Results will be shared in the chat.',
      confirm: 'Confirm',
      cancel: 'Cancel',
      closed: 'Closed',
      pollLabel: 'Poll',
      pollResultsLabel: 'Poll Results',
      startedPoll: (name: string) => `${name} started a poll`,
      closedPoll: (name: string) => `${name} closed the poll`,
      questionLabel: 'Question',
      questionPlaceholder: 'What would you like to ask?',
      descriptionLabel: 'Description (optional)',
      descriptionPlaceholder: 'Add more context...',
      optionsLabel: 'Options',
      optionPlaceholder: (letter: string) => `Option ${letter}`,
      addOption: '+ Add option',
      pollTypeLabel: 'Poll type',
      createError: 'Failed to create poll. Please try again.',
    },
    emoji: {
      openPicker: 'Open emoji picker',
      closePicker: 'Close emoji picker',
      reactWith: 'React with emoji',
      insertEmoji: 'Insert emoji',
      removeReaction: 'Remove reaction',
      reactors: 'Reactors',
      reactionCount: 'reactions',
    },
    updateBanner: {
      message: 'A new version is available.',
      reload: 'Reload',
      dismissAriaLabel: 'Dismiss update notification',
    },
    feedback: {
      settingsRowLabel: 'Send feedback to the maintainers',
      pageTitle: 'Feedback to the Few team',
      encryptedSubtitle: 'End-to-end encrypted · only the team can read this',
      composerPlaceholder: 'Describe a bug, suggest a feature, or say hello…',
      unavailableState: 'Feedback is currently unavailable.',
    },
    advanced: {
      sectionTitle: 'Advanced',
      toggleExpand: 'Show advanced settings',
      toggleCollapse: 'Hide advanced settings',
      relays: {
        sectionTitle: 'Relay servers',
        addPlaceholder: 'wss://relay.example.com',
        addBtn: 'Add',
        removeBtn: 'Remove',
        resetBtn: 'Reset to defaults',
        saveBtn: 'Save',
        savedSuccess: 'Relay list saved.',
        statusConnected: 'Connected',
        statusConnecting: 'Connecting',
        statusDisconnected: 'Disconnected',
        lastRelayError: 'At least one relay is required.',
        invalidUrlError: 'Enter a valid wss:// or ws:// URL.',
        duplicateUrlError: 'This relay is already in the list.',
        discoverabilityNote: 'Existing groups\' relay lists are not changed.',
      },
      dangerZone: {
        title: 'Danger Zone',
        wipeBtn: 'Wipe this device',
        wipeConfirmPrompt: 'Type WIPE to confirm',
        wipeConfirmBtn: 'Confirm wipe',
        wipeConfirmWord: 'WIPE',
        wipeCancel: 'Cancel',
        wipeWarning: 'This permanently clears your identity, all groups, and all message history from this device. This cannot be undone.',
      },
      nip46: {
        sectionTitle: 'Remote Signer',
        description: 'Connect a hardware signer, browser extension backend, or nsecBunker to keep your identity key off this device.',
        disclosureGroupFast: 'Group messages stay fast — group keys are always local.',
        disclosureIdentityLeaves: 'Your identity key will be held by the remote signer, not the browser.',
        disclosureDmSlow: 'Direct message history and large group invites will be slower due to remote signing.',
        connectQrBtn: 'Connect via QR / Deep link',
        connectPasteBtn: 'Paste a bunker:// URI',
        relayInputLabel: 'Rendezvous relay',
        relayInputPlaceholder: 'wss://relay.nsec.app',
        generateQrBtn: 'Generate QR',
        confirmConnectBtn: "I've approved — Connect",
        pasteUriLabel: 'Bunker URI',
        pasteUriPlaceholder: 'bunker://...',
        connectBtn: 'Connect',
        connecting: 'Connecting…',
        connected: 'Connected to remote signer',
        connectedAs: 'Connected as',
        reconnecting: 'Reconnecting to signer…',
        disconnect: 'Disconnect',
        signerUnavailable: 'Remote signer is unavailable. Publishing is paused.',
        retryBtn: 'Retry',
        errorUnreachable: 'Bunker unreachable. Check that your signer app is open and try again.',
        authChallengeOpened: 'An authorisation page was opened in a new tab.',
      },
      nip07: {
        sectionTitle: 'Browser Extension',
        description: 'Sign with a browser extension (Alby, nos2x-fox). No network latency — the extension signs locally.',
        connectBtn: 'Connect Extension',
        connecting: 'Connecting to extension…',
        connected: 'Connected to extension',
        connectedAs: 'Signed in as',
        disconnect: 'Disconnect',
        noExtensionError: 'No Nostr extension found. Install Alby or nos2x-fox.',
        nip44MissingError: 'This extension does not support NIP-44 encryption. Group features require NIP-44 (try Alby or nos2x-fox).',
        reconnectError: 'Extension is unavailable. Please reconnect.',
      },
    },
    calls: {
      incomingCallTitle: 'Incoming Call',
      incomingVoiceCall: 'Voice Call',
      incomingVideoCall: 'Video Call',
      acceptCall: 'Accept',
      declineCall: 'Decline',
      muteAudio: 'Mute',
      unmuteAudio: 'Unmute',
      cameraOff: 'Camera Off',
      cameraOn: 'Camera On',
      hangUp: 'Hang Up',
      participants: (count: number) => `${count} participant${count === 1 ? '' : 's'}`,
      callConnected: 'Call connected',
      startVoiceCall: 'Voice Call',
      startVideoCall: 'Video Call',
      callDisabledGroupFull: 'Group too large for calls (max 5)',
      callInProgress: 'Call in progress',
      callSettings: 'Call Settings',
      turnServerUrl: 'TURN Server URL',
      turnUsername: 'TURN Username',
      turnCredential: 'TURN Credential',
      saveTurnConfig: 'Save',
      ipPrivacyMode: 'IP Privacy Mode',
      turnHelp: 'Calls work out of the box using the public openrelayproject TURN relay — the same one Amethyst uses. Leave blank to keep it, or enter your own relay below.',
      ipPrivacyHelp: 'Route media through TURN to hide your IP from call participants (increases latency).',
      callStartedNotice: (callerName: string) => `${callerName} started a call`,
      callEndedNotice: 'Call ended',
    },
    scanner: {
      fabAriaLabel: 'Scan QR code',
      tabLabel: 'Scan',
      title: 'Scan QR Code',
      startingCamera: 'Starting camera...',
      permissionDenied: 'Camera permission was denied.',
      unavailable: 'QR scanning is unavailable on this device or browser.',
      unrecognisedLink: "This QR code isn't a few.chat contact card or group invite.",
    },
  },
  de: {
    appName: 'few.chat',
    languageNames: { en: 'English', de: 'Deutsch' },
    layout: {
      nav: {
        contacts: 'Kontakte',
        groups: 'Gruppen',
        settings: 'Einstellungen',
        info: 'Wie funktioniert few.chat?',
        profile: 'Profil',
      },
      languageLabel: 'Sprache',
      mobileMenuLabel: 'Navigationsmenü umschalten',
      profileNamePlaceholder: 'Du',
      unreadMessages: (count: number) => count === 1 ? '1 neue Nachricht' : `${count} neue Nachrichten`,
      backupNeededLabel: 'Sicherung erforderlich',
      imprintLink: 'Impressum',
    },
    imprint: {
      pageTitle: 'Impressum',
      heading: 'Impressum',
    },
    info: {
      pageTitle: 'Wie es funktioniert',
      heading: 'Wie funktioniert few.chat?',
    },
    home: {
      title: 'Willkommen bei few.chat',
      description:
        'Private, Ende-zu-Ende-verschlüsselte Chats. Schreibe deinen Kontakten direkt oder unterhalte dich gemeinsam in Gruppen.',
      subheadingLead: 'Einfach nur chatten.',
      subheadingPoints: [
        'Keine E-Mail-Adresse nötig',
        'Kein Login, kein Passwort zum Merken',
        'Keine Telefonnummer erforderlich',
        'Keine Kontaktanfragen von Fremden',
        'Völlig kostenlos',
      ],
      contactsTitle: 'Kontakte',
      contactsSubtitle: 'Schreibe den Personen, die du kennst, direkt.',
      groupsTitle: 'Gruppen',
      groupsSubtitle: 'Chattet gemeinsam in Gruppen.',
      profileTitle: 'Profil',
      profileSubtitle: 'Verwalte deinen Namen und Avatar.',
      howTitle: 'Wie funktioniert few.chat?',
      howSubtitle: 'Ein kurzer Blick darauf, was es privat macht.',
    },
    settings: {
      pageTitle: 'Einstellungen',
      heading: 'Einstellungen',
      nicknameHeading: 'Name',
      nicknameLimit: (max: number) => `Der Name hat die Grenze von ${max} Zeichen erreicht (Umlaute und Emojis zählen mehr).`,
      avatarHeading: 'Avatar',
      changeAvatar: 'Avatar ändern',
      avatarModalTitle: 'Wähle deinen Avatar',
      fruitNames: {
        apple: 'Apfel',
        apricot: 'Aprikose',
        avocado: 'Avocado',
        banana: 'Banane',
        'bell pepper': 'Paprika',
        blackberry: 'Brombeere',
        blueberry: 'Heidelbeere',
        'bok choy': 'Pak Choi',
        broccoli: 'Brokkoli',
        'butternut squash': 'Butternusskürbis',
        cactus: 'Kaktus',
        carrot: 'Karotte',
        celery: 'Sellerie',
        cherry: 'Kirsche',
        'chili pepper': 'Chilischote',
        clementine: 'Clementine',
        coconut: 'Kokosnuss',
        corn: 'Mais',
        cranberry: 'Cranberry',
        cucumber: 'Gurke',
        durian: 'Durian',
        edamame: 'Edamame',
        eggplant: 'Aubergine',
        fig: 'Feige',
        garlic: 'Knoblauch',
        'goji berry': 'Gojibeere',
        grapefruit: 'Grapefruit',
        'green bean': 'Grüne Bohne',
        guava: 'Guave',
        jalapeno: 'Jalapeño',
        kale: 'Grünkohl',
        'kiwi fruit': 'Kiwi',
        lemon: 'Zitrone',
        lettuce: 'Kopfsalat',
        lime: 'Limette',
        mango: 'Mango',
        mushroom: 'Pilz',
        papaya: 'Papaya',
        parsnip: 'Pastinake',
        peanut: 'Erdnuss',
        pear: 'Birne',
        pineapple: 'Ananas',
        plantain: 'Kochbanane',
        plum: 'Pflaume',
        pomegranate: 'Granatapfel',
        potato: 'Kartoffel',
        radish: 'Radieschen',
        raspberry: 'Himbeere',
        strawberry: 'Erdbeere',
        'sweet potato': 'Süßkartoffel',
        tangerine: 'Mandarine',
        tomato: 'Tomate',
        turnip: 'Speiserübe',
        watermelon: 'Wassermelone',
        zucchini: 'Zucchini',
      },
      avatarNoResults: 'Zu dieser Frucht gibt es noch keine Avatare. Versuche eine andere.',
      selectedAvatarAlt: 'Ausgewählter Avatar',
      avatarOptionAlt: 'Avataroption',
      languageHeading: 'Sprache',
      languageDescription: 'Lege fest, in welcher Sprache die App angezeigt wird.',
      themeHeading: 'Design',
      themeDescription: 'Wähle das visuelle Design der App.',
      cancel: 'Abbrechen',
    },
    storage: {
      title: 'Speicher nicht verfügbar',
      description:
        'Der lokale Speicher deines Browsers ist nicht verfügbar (Privatmodus?). Die App funktioniert trotzdem, aber deine Einstellungen werden nicht zwischen Sitzungen gespeichert.',
      dismiss: 'Warnung ausblenden',
    },
    identity: {
      npubLabel: 'Dein öffentlicher Schlüssel (npub)',
      copyNpub: 'npub kopieren',
      copiedNpub: 'Kopiert!',
      showQr: 'QR zeigen',
      qrModalTitle: 'Npub-QR-Code',
      qrGenerationError: 'QR-Code konnte nicht erstellt werden.',
      backupHeading: 'Identität sichern',
      backupDescription:
        'Erstelle eine Wiederherstellungsphrase, um deine Identität bei gelöschten Browser-Daten zurückzugewinnen.',
      generatePhrase: 'Wiederherstellungsphrase erstellen',
      backupWarning:
        'Schreibe diese 12 Wörter in der richtigen Reihenfolge auf und bewahre sie sicher auf.',
      backupConfirmCheck: 'Ich habe meine Wiederherstellungsphrase aufgeschrieben',
      backupDone: 'Identität erfolgreich gesichert.',
      restoreHeading: 'Aus Backup wiederherstellen',
      restoreDescription: 'Gib deine 12-Wort-Phrase ein, um deine Identität wiederherzustellen.',
      restoreInput: 'Wiederherstellungsphrase eingeben...',
      restoreButton: 'Identität wiederherstellen',
      restoreSuccess: 'Identität erfolgreich wiederhergestellt.',
      restoreError: 'Ungültige Phrase. Bitte Wörter prüfen und erneut versuchen.',
      backupNotFound: 'Es wurde keine Sicherung deiner App-Daten gefunden. Nur deine Identität wurde wiederhergestellt.',
      backupUnreachable: 'Die Relays waren nicht erreichbar, um nach einer Sicherung deiner App-Daten zu suchen.',
      backupCheckAgain: 'Erneut prüfen',
      backupUnusable: 'Eine Sicherung wurde gefunden, aber diese App-Version kann sie nicht verwenden. Aktualisiere die App und stelle erneut wieder her.',
      backupApplyError: 'Deine Identität wurde wiederhergestellt, aber das Einspielen der Sicherung ist fehlgeschlagen.',
      backupRestoreTitle: 'Aus Sicherung wiederherstellen?',
      backupRestoreBody:
        'Eine Sicherung deiner Gruppen und Einstellungen wurde gefunden. Beim Wiederherstellen wird sie zu diesem Gerät hinzugefügt; auf diesem Gerät wird nichts gelöscht.',
      backupRestoreSkip: 'Überspringen',
      backupRestoreConfirm: 'Wiederherstellen',
      backupReminderTitle: 'Identität sichern',
      backupReminderBody:
        'Du bist in einer Gruppe, hast deine Identität aber noch nicht gesichert.',
      backupReminderAction: 'Jetzt sichern',
      backupReminderDismiss: 'Schließen',
      notReady: 'Identität wird vorbereitet',
    },
    groups: {
      pageTitle: 'Gruppen',
      heading: 'Gruppen',
      noGroups: 'Du bist noch in keiner Gruppe.',
      noGroupsBody: 'Erstelle eine Gruppe oder warte auf eine Einladung von einem Freund.',
      createGroup: 'Gruppe erstellen',
      createGroupTitle: 'Gruppe erstellen',
      createGroupNameLabel: 'Gruppenname',
      createGroupSubmit: 'Gruppe erstellen',
      cancel: 'Abbrechen',
      memberCount: (count) => `${count} Mitglied${count !== 1 ? 'er' : ''}`,
      inviteMember: 'Mitglied einladen',
      inviteTitle: 'Kontakt einladen',
      inviteContactLabel: 'Kontakt auswählen',
      inviteReasonAlreadyMember: 'bereits in der Gruppe',
      inviteReasonBlocked: 'blockiert',
      inviteReasonPendingConfirmation: 'noch nicht bestätigt',
      inviteGuidanceMessage: 'Keine Kontakte zum Einladen verfügbar. Füge Kontakte hinzu, indem du deine Profilkarte über die Kontakte-Seite teilst.',
      inviteGuidanceLink: 'Zu den Kontakten',
      inviteSubmit: 'Einladung senden',
      inviteSuccess: 'Einladung erfolgreich gesendet.',
      inviteErrorNoKeyPackage: 'Dieser Nutzer hat seine Few-Identität noch nicht eingerichtet.',
      inviteErrorInvalidNpub: 'Ungültiges npub-Format.',
      inviteErrorOffline: 'Du bist offline. Bitte verbinde dich, um Mitglieder einzuladen.',
      inviteErrorTimeout: 'Relay-Zeitüberschreitung. Bitte erneut versuchen.',
      inviteErrorGeneric: 'Einladung fehlgeschlagen. Bitte erneut versuchen.',
      leaveGroup: 'Gruppe verlassen',
      leaveGroupTitle: 'Gruppe verlassen?',
      leaveGroupBody: 'Du verlierst den Zugriff auf diese Gruppe und ihre Nachrichten.',
      leaveGroupConfirm: 'Gruppe verlassen',
      abandonGroupTitle: 'Gruppe auflösen?',
      abandonGroupBody: 'Du bist das letzte Mitglied. Wenn du die Gruppe verlässt, wird sie endgültig gelöscht und kann nicht wiederhergestellt werden.',
      abandonGroupConfirm: 'Gruppe auflösen',
      loading: 'Wird geladen...',
      offlineBanner: 'Offline — Gruppensynchronisation nicht verfügbar',
      offlineLastSync: (time) => `Zuletzt synchronisiert: ${time}`,
      syncNow: 'Jetzt synchronisieren',
      fromGroup: (name) => `Aus Gruppe: ${name}`,
      softLimitWarning: 'Diese Gruppe nähert sich dem empfohlenen Limit von 50 Mitgliedern.',
      navLabel: 'Gruppen',
      showQr: 'QR-Code zeigen',
      scanQr: 'QR-Code scannen',
      qrModalTitle: 'Npub-QR-Code',
      qrScannerTitle: 'Npub-QR-Code scannen',
      qrScannerHint: 'Richte die Kamera auf einen QR-Code mit einer npub.',
      qrStartingCamera: 'Kamera wird gestartet...',
      qrInvalidPayload: 'Dieser QR-Code enthält keine gültige npub.',
      cameraPermissionDenied: 'Kamerazugriff wurde verweigert.',
      qrUnavailable: 'QR-Scan ist auf diesem Gerät oder Browser nicht verfügbar.',
      qrGenerationError: 'QR-Code konnte nicht erstellt werden.',
      httpsRequired: 'HTTPS erforderlich',
      httpsRequiredBody: 'Verschlüsselte Gruppen erfordern eine sichere Verbindung (HTTPS). Bitte greife über HTTPS auf diese Seite zu, um Gruppen zu nutzen.',
      inviteLinkButton: 'Einladungslink',
      inviteLinkTitle: 'Einladungslink erstellen',
      inviteLinkCopy: 'Link kopieren',
      inviteLinkCopied: 'Link in Zwischenablage kopiert',
      inviteLinkCopyError: 'Link konnte nicht kopiert werden',
      inviteLinkLabelField: 'Bezeichnung (optional)',
      inviteLinkLabelPlaceholder: 'z. B. An Klassen-Chat gesendet',
      joinRequestHeading: 'Du wurdest zu einer Gruppe eingeladen',
      joinRequestDescription: 'Beitrittsanfrage an den Gruppenadmin senden?',
      joinRequestNameLabel: 'Dein Name',
      joinRequestNameHelper: 'Der Gruppenadmin sieht diesen Namen bei deiner Beitrittsanfrage.',
      joinRequestNameRequiredHint: 'Gib einen Namen ein, um fortzufahren',
      joinRequestButton: 'Beitritt anfragen',
      joinRequestSent: 'Anfrage gesendet! Du wirst hinzugefügt, sobald der Admin zustimmt.',
      joinRequestError: 'Beitrittsanfrage fehlgeschlagen. Bitte erneut versuchen.',
      joinRequestAlreadyMember: 'Du bist bereits Mitglied dieser Gruppe.',
      joinRequestGoToGroup: 'Zur Gruppe',
      pendingRequestsApprove: 'Genehmigen',
      pendingRequestsDeny: 'Ablehnen',
      pendingRequestsApproveError: 'Anfrage konnte nicht genehmigt werden. Bitte erneut versuchen.',
      manageLinksButton: 'Links verwalten',
      manageLinksTitle: 'Einladungslinks verwalten',
      manageLinksDeactivateLabel: 'Deaktiviert',
      manageLinksUntitled: 'Ohne Titel',
      manageLinksCreatedAt: (dateTime: string) => `Erstellt am ${dateTime}`,
      manageLinksExpiresInHours: (hours: number) => hours === 1 ? 'Läuft in 1 Std. ab' : `Läuft in ${hours} Std. ab`,
      manageLinksExpiresInMinutes: (minutes: number) => minutes === 1 ? 'Läuft in 1 Min. ab' : `Läuft in ${minutes} Min. ab`,
      manageLinksExpiredHoursAgo: (hours: number) => hours === 1 ? 'Vor 1 Std. abgelaufen' : `Vor ${hours} Std. abgelaufen`,
      manageLinksExpiredMinutesAgo: (minutes: number) => minutes === 1 ? 'Vor 1 Min. abgelaufen' : `Vor ${minutes} Min. abgelaufen`,
      manageLinksExpiredMarker: 'Abgelaufen',
      manageLinksUsageCount: (count: number) => count === 1 ? '1 Person ist über diesen Link beigetreten' : `${count} Personen sind über diesen Link beigetreten`,
      manageLinksRemoveButtonLabel: 'Link entfernen',
      manageLinksRemoveConfirm: 'Diesen Link entfernen?',
      manageLinksRemoveConfirmButton: 'Entfernen',
      manageLinksEmpty: 'Noch keine Einladungslinks.',
      membersHeading: 'Mitglieder',
      chatHeading: 'Chat',
      groupNotFound: 'Gruppe nicht gefunden.',
      backToGroups: 'Zurück zu Gruppen',
      noMembersYet: 'Noch keine Mitglieder.',
      memberPending: 'Ausstehend',
      memberRequestedBadge: 'Beitritt angefragt',
      memberYou: 'Du',
      cancelInviteButton: 'Einladung zurückziehen',
      cancelInviteTitle: 'Ausstehende Einladung zurückziehen',
      cancelInviteBody: 'Diese ausstehende Einladung zurückziehen? Das Mitglied wird dauerhaft aus der Gruppe entfernt.',
      cancelInviteConfirm: 'Bestätigen',
      cancelInviteSuccess: 'Einladung zurückgezogen',
      cancelInviteError: 'Einladung konnte nicht zurückgezogen werden',
      cancelInviteRaceNotice: 'Diese Einladung ist nicht mehr ausstehend',
      cancelInviteAnnouncementWarning: 'Einladung zurückgezogen, aber der Gruppenchat konnte nicht benachrichtigt werden',
      removeMemberButton: 'Mitglied entfernen',
      removeMemberTitle: 'Mitglied entfernen',
      removeMemberBody:
        'Dieses Mitglied aus der Gruppe entfernen? Es verliert den Zugriff auf die Gruppe und ihre Nachrichten.',
      removeMemberConfirm: 'Entfernen',
      removeMemberSuccess: 'Mitglied entfernt',
      removeMemberError: 'Mitglied konnte nicht entfernt werden',
      cancelledByAnnouncement: (member: string, canceller: string) => `${member} wurde von ${canceller} ausgeladen`,
      leftGroup: (member: string) => `${member} hat die Gruppe verlassen`,
      renameGroupButton: 'Gruppe umbenennen',
      renameGroupSave: 'Namen speichern',
      renameGroupCancel: 'Umbenennen abbrechen',
      renameGroupSuccess: 'Gruppe umbenannt',
      renameGroupError: 'Gruppe konnte nicht umbenannt werden. Bitte erneut versuchen.',
      renamedGroupAnnouncement: (actor: string, name: string) => `${actor} hat die Gruppe in „${name}“ umbenannt`,
      admittedMemberAnnouncement: (admitter: string, member: string) => `${admitter} hat ${member} aufgenommen`,
      inviteLifecycleInvited: (invitee: string) => `${invitee} wurde eingeladen`,
      inviteLifecycleAccepted: (invitee: string) => `${invitee} ist der Gruppe beigetreten`,
      inviteLifecycleDeclined: (invitee: string) => `${invitee} hat die Einladung abgelehnt`,
      makeAdminButton: 'Als Admin festlegen',
      makeAdminTitle: 'Als Admin festlegen?',
      makeAdminBody: 'Das kann nicht rückgängig gemacht werden. Admins können Mitglieder einladen, Beitrittsanfragen bestätigen, Einladungen zurückziehen und anderen Admin-Rechte erteilen.',
      makeAdminConfirm: 'Als Admin festlegen',
      makeAdminSuccess: 'Admin-Rechte erteilt',
      makeAdminError: 'Admin-Rechte konnten nicht erteilt werden. Bitte erneut versuchen.',
      adminBadge: 'Admin',
      lastAdminLeaveBlocked: 'Du bist der einzige Admin. Erteile einem anderen Mitglied Admin-Rechte, bevor du die Gruppe verlässt.',
      leavePendingBadge: 'Verlassen, Bereinigung ausstehend',
      // removalPendingBadge: reserved for future cause-distinction (see English comment above).
      removalPendingBadge: 'Entfernung ausstehend',
      chatLoading: 'Nachrichten werden geladen...',
      chatEmpty: 'Noch keine Nachrichten. Sag Hallo!',
      chatPlaceholder: 'Nachricht eingeben...',
      chatSend: 'Nachricht senden',
      chatNewMessages: 'Neue Nachrichten',
      chatJustNow: 'gerade eben',
      chatMinutesAgo: (minutes: number) => `vor ${minutes} Min.`,
      createGroupError: 'Gruppe konnte nicht erstellt werden. Bitte erneut versuchen.',
      profileSendFailed: 'Dein Profil konnte nicht gesendet werden – dein Signierer ist gesperrt oder nicht verfügbar.',
      imageAttachmentLabel: 'Bild anhängen',
      imageProcessing: 'Bild wird verarbeitet…',
      imageUploading: (pct: number) => `Wird hochgeladen ${pct} %`,
      imageSendFailed: 'Bild konnte nicht gesendet werden',
      imageRetry: 'Erneut versuchen',
      imageDecryptFailed: 'Bild konnte nicht entschlüsselt werden',
      imageUnavailable: 'Bild ist nicht mehr verfügbar',
      imageDownload: 'Herunterladen',
      imageTooLarge: 'Bild ist zu groß',
      imageRemove: 'Bild entfernen',
      msgEditAction: 'Bearbeiten',
      msgDeleteAction: 'Löschen',
      msgEditingBadge: 'Nachricht wird bearbeitet',
      msgEditSave: 'Änderung speichern',
      msgEditEmptyHint: 'Eine Nachricht darf nicht leer sein — lösche sie stattdessen.',
      msgDeleteConfirmPrompt: 'Diese Nachricht löschen?',
      msgDeleteConfirmButton: 'Ja, löschen',
      msgEditedMarker: '(bearbeitet)',
      listPreviewPhoto: 'Foto',
      listPreviewEmpty: 'Noch keine Nachrichten',
      listPreviewStructured: 'Neue Aktivität',
      pendingInvitations: {
        badge: 'Einladung',
        invitedBy: (name: string) => `Eingeladen von ${name}`,
        unknownGroupFallback: 'Gruppeneinladung',
        adminLabel: 'Gruppen-Admins',
        acceptBtn: 'Annehmen',
        declineBtn: 'Ablehnen',
        acceptError: 'Diese Einladung ist nicht mehr gültig',
      },
      inviteAwaitingBanner: (groupName: string) => `Du wurdest eingeladen, der Gruppe ${groupName} beizutreten.`,
      awaitingApprovalBanner: (groupName: string) => `Warte darauf, dass der Admin deine Anfrage zum Beitritt zu ${groupName} genehmigt.`,
      awaitingBadgeLabel: 'Ausstehend',
      cancelOutboundRequestLabel: 'Anfrage zurückziehen',
    },
    contacts: {
      pageTitle: 'Kontakte',
      heading: 'Kontakte',
      emptyTitle: 'Noch keine Kontakte',
      emptyBody: 'Tritt einer Gruppe mit anderen Personen bei oder öffne eine Kontaktkarte, die dir jemand teilt, dann erscheinen sie hier.',
      listHeading: 'Alle Kontakte',
      hideHiddenOption: 'Blockierte Kontakte ausblenden',
      showHiddenOption: (count: number) => count === 0 ? 'Blockierte Kontakte anzeigen' : `Blockierte Kontakte anzeigen (${count})`,
      hiddenOnlyBody: (count: number) => count === 1 ? '1 blockierter Kontakt wird aktuell ausgeblendet.' : `${count} blockierte Kontakte werden aktuell ausgeblendet.`,
      hiddenBadge: 'Blockiert',
      archivedDetailNotice: 'Du hast diesen Kontakt blockiert. Seine Nachrichten werden gefiltert und euer Gesprächsverlauf wurde gelöscht.',
      blockConfirmTitle: 'Kontakt blockieren?',
      blockConfirmBody: 'Wenn du diesen Kontakt blockierst, wird euer Gesprächsverlauf gelöscht und er kann dir keine Nachrichten mehr senden. Dies kann nicht rückgängig gemacht werden.',
      blockConfirmButton: 'Kontakt blockieren',
      blockCancelButton: 'Abbrechen',
      profileNameFallback: 'Kontakt ohne Namen',
      backToContacts: 'Zurück zu Kontakten',
      contactNotFound: 'Kontakt nicht gefunden.',
      commonGroups: (names: string[]) => `Gruppen: ${names.join(', ')}`,
      addContactSuccess: 'Kontakt hinzugefügt',
      addContactPairingInFlight: 'Kontakt hinzugefügt — du solltest in Kürze bei ihnen erscheinen.',
      addContactErrorInvalidNpub: 'Das sieht nicht nach einem gültigen Npub aus. Bitte überprüfe die Eingabe.',
      addContactErrorSelf: 'Du kannst dich nicht selbst als Kontakt hinzufügen.',
      addContactErrorAlreadyExists: 'Diese Person ist bereits in deinen Kontakten.',
      addContactErrorGeneric: 'Der Kontakt konnte nicht hinzugefügt werden. Bitte versuche es erneut.',
      addContactErrorUnsupportedVersion: 'Diese Kontaktkarte benötigt eine neuere Version der App. Bitte aktualisiere die App und versuche es erneut.',
      pairingAdmissionDigest: (count: number) => `${count} Personen haben sich über deinen Code verbunden`,
      pendingBadge: 'Ausstehend',
      pendingConfirmHeading: 'Diesen Kontakt bestätigen?',
      pendingConfirmBody: (name: string) => `${name} hat deine Kontaktkarte gescannt. Ihre Nachrichten werden zurückgehalten, bis du bestätigst, dass du sie kennst.`,
      pendingConfirmButton: 'Kontakt bestätigen',
      pendingRejectButton: 'Ablehnen',
    },
    add: {
      pageTitle: 'Kontakt hinzufügen',
      heading: 'Kontakt hinzufügen',
      settingUp: 'Dein Konto wird eingerichtet …',
      redirecting: 'Dein neuer Kontakt wird geöffnet …',
      noCard: 'Dieser Link enthält keine Kontaktkarte.',
      goToContacts: 'Zu den Kontakten',
    },
    welcome: {
      contactInviteLine: (name: string) => `${name} hat dich zu few.chat eingeladen`,
      groupInviteLine: (group: string) => `Du bist eingeladen, der Gruppe ${group} beizutreten`,
      nameLabel: 'Dein Name',
      namePlaceholder: 'Du',
      contactPrimaryAction: "Los geht's",
    },
    profile: {
      pageTitle: 'Profil',
      backLabel: 'Zurück',
      copyNpub: 'Kopieren',
      copiedNpub: 'Kopiert!',
      shareCardHeading: 'Kontaktkarte teilen',
      shareCardDescription:
        'Teile einen signierten Link, der dich mit Namen hinzufügt — kein Relay, keine öffentliche Profilübertragung. Er ist etwa 30 Minuten lang gültig, teile ihn also, während ihr beide online sein könnt. Andere öffnen ihn oder scannen den QR-Code, um dich hinzuzufügen.',
      shareCardValidityHint: 'Dieser Code funktioniert etwa 30 Minuten lang.',
      shareCardButton: 'Kontaktkarte teilen',
      shareCardNeedsName: 'Lege oben einen Namen fest, um deine Kontaktkarte teilen zu können.',
      shareCardNeedsNameContacts: 'Lege in deinem Profil einen Namen fest, um deine Kontaktkarte teilen zu können.',
      shareCardNeedsNameContactsLink: 'Zum Profil',
      shareCardTitle: 'Kontaktkarte teilen',
      copyCardLink: 'Kartenlink kopieren',
      copiedCardLink: 'Kopiert!',
      shareCardError: 'Kartenerstellung fehlgeschlagen. Bitte erneut versuchen.',
      sendDm: 'Nachricht senden',
      archiveAction: 'Kontakt blockieren',
      unarchiveAction: 'Kontakt entsperren',
      blockedNotice: 'Du hast diesen Kontakt blockiert. Entsperre ihn, um Nachrichten zu senden oder ihn zu einer Gruppe hinzuzufügen.',
      viewProfile: 'Profil ansehen',
      notFound: 'Profil nicht gefunden.',
      addToGroupLabel: 'Zu einer Gruppe hinzufügen',
      addToGroupSelect: 'Gruppe auswählen',
      addToGroupBtn: 'Zur Gruppe hinzufügen',
      addToGroupSuccess: 'Kontakt zur Gruppe hinzugefügt.',
      addToGroupError: 'Kontakt konnte nicht zur Gruppe hinzugefügt werden. Bitte versuche es erneut.',
      ownHeading: 'Mein Profil',
      ownDescription: 'So sehen dich andere.',
      backupNeededHint: 'Deine Identität ist noch nicht gesichert. Gehe zu Einstellungen, um sie zu sichern.',
      pairingNameSetupPrompt: 'Lege einen Namen fest, damit sie wissen, dass du sie zurück hinzugefügt hast.',
    },
    polls: {
      heading: (count: number) => count > 0 ? `Umfragen (${count})` : 'Umfragen',
      noPolls: 'Noch keine Umfragen',
      createPoll: 'Umfrage erstellen',
      pollButton: 'neue Umfrage',
      singleChoice: 'Einzelauswahl',
      multipleChoice: 'Mehrfachauswahl',
      vote: 'Abstimmen',
      updateVote: 'Stimme ändern',
      voted: 'Abgestimmt',
      voteCount: (count: number) => count === 1 ? '1 Stimme' : `${count} Stimmen`,
      voterCount: (count: number) => count === 1 ? '1 Teilnehmer' : `${count} Teilnehmer`,
      closePoll: 'Umfrage schließen',
      closeConfirm: 'Umfrage schließen? Ergebnisse werden im Chat geteilt.',
      confirm: 'Bestätigen',
      cancel: 'Abbrechen',
      closed: 'Geschlossen',
      pollLabel: 'Umfrage',
      pollResultsLabel: 'Umfrageergebnisse',
      startedPoll: (name: string) => `${name} hat eine Umfrage gestartet`,
      closedPoll: (name: string) => `${name} hat die Umfrage geschlossen`,
      questionLabel: 'Frage',
      questionPlaceholder: 'Was möchtest du fragen?',
      descriptionLabel: 'Beschreibung (optional)',
      descriptionPlaceholder: 'Mehr Kontext hinzufügen...',
      optionsLabel: 'Optionen',
      optionPlaceholder: (letter: string) => `Option ${letter}`,
      addOption: '+ Option hinzufügen',
      pollTypeLabel: 'Umfragetyp',
      createError: 'Umfrage konnte nicht erstellt werden. Bitte erneut versuchen.',
    },
    emoji: {
      openPicker: 'Emoji-Auswahl öffnen',
      closePicker: 'Emoji-Auswahl schließen',
      reactWith: 'Mit Emoji reagieren',
      insertEmoji: 'Emoji einfügen',
      removeReaction: 'Reaktion entfernen',
      reactors: 'Reagiert von',
      reactionCount: 'Reaktionen',
    },
    updateBanner: {
      message: 'Eine neue Version ist verfügbar.',
      reload: 'Neu laden',
      dismissAriaLabel: 'Update-Benachrichtigung schließen',
    },
    feedback: {
      settingsRowLabel: 'Feedback an die Entwickler senden',
      pageTitle: 'Feedback an das Few-Team',
      encryptedSubtitle: 'Ende-zu-Ende verschlüsselt · nur das Team kann dies lesen',
      composerPlaceholder: 'Fehler beschreiben, Feature vorschlagen oder einfach hallo sagen…',
      unavailableState: 'Feedback ist momentan nicht verfügbar.',
    },
    advanced: {
      sectionTitle: 'Erweitert',
      toggleExpand: 'Erweiterte Einstellungen anzeigen',
      toggleCollapse: 'Erweiterte Einstellungen ausblenden',
      relays: {
        sectionTitle: 'Relay-Server',
        addPlaceholder: 'wss://relay.beispiel.de',
        addBtn: 'Hinzufügen',
        removeBtn: 'Entfernen',
        resetBtn: 'Auf Standard zurücksetzen',
        saveBtn: 'Speichern',
        savedSuccess: 'Relay-Liste gespeichert.',
        statusConnected: 'Verbunden',
        statusConnecting: 'Verbinde …',
        statusDisconnected: 'Getrennt',
        lastRelayError: 'Mindestens ein Relay ist erforderlich.',
        invalidUrlError: 'Bitte eine gültige wss:// oder ws://-URL eingeben.',
        duplicateUrlError: 'Dieses Relay ist bereits in der Liste.',
        discoverabilityNote: 'Relay-Listen bestehender Gruppen werden nicht geändert.',
      },
      dangerZone: {
        title: 'Gefahrenzone',
        wipeBtn: 'Dieses Gerät löschen',
        wipeConfirmPrompt: 'Gib WIPE ein, um zu bestätigen',
        wipeConfirmBtn: 'Löschen bestätigen',
        wipeConfirmWord: 'WIPE',
        wipeCancel: 'Abbrechen',
        wipeWarning: 'Hierdurch werden deine Identität, alle Gruppen und der gesamte Nachrichtenverlauf auf diesem Gerät dauerhaft gelöscht. Dies kann nicht rückgängig gemacht werden.',
      },
      nip46: {
        sectionTitle: 'Externer Signierer',
        description: 'Verbinde einen Hardware-Signierer, eine Browser-Erweiterung oder nsecBunker, um deinen Identitätsschlüssel aus dem Browser zu halten.',
        disclosureGroupFast: 'Gruppennachrichten bleiben schnell — Gruppenschlüssel sind immer lokal.',
        disclosureIdentityLeaves: 'Dein Identitätsschlüssel wird vom externen Signierer gehalten, nicht im Browser.',
        disclosureDmSlow: 'Direktnachrichten-Verlauf und große Gruppeneinladungen werden durch das externe Signieren langsamer.',
        connectQrBtn: 'Per QR / Deep Link verbinden',
        connectPasteBtn: 'bunker://-URI einfügen',
        relayInputLabel: 'Rendezvous-Relay',
        relayInputPlaceholder: 'wss://relay.nsec.app',
        generateQrBtn: 'QR erstellen',
        confirmConnectBtn: 'Genehmigt — Verbinden',
        pasteUriLabel: 'Bunker-URI',
        pasteUriPlaceholder: 'bunker://...',
        connectBtn: 'Verbinden',
        connecting: 'Verbinde …',
        connected: 'Mit externem Signierer verbunden',
        connectedAs: 'Verbunden als',
        reconnecting: 'Verbindung zum Signierer wird wiederhergestellt …',
        disconnect: 'Verbindung trennen',
        signerUnavailable: 'Externer Signierer nicht verfügbar. Veröffentlichung pausiert.',
        retryBtn: 'Erneut versuchen',
        errorUnreachable: 'Bunker nicht erreichbar. Prüfe, ob deine Signierer-App geöffnet ist, und versuche es erneut.',
        authChallengeOpened: 'Eine Autorisierungsseite wurde in einem neuen Tab geöffnet.',
      },
      nip07: {
        sectionTitle: 'Browser-Erweiterung',
        description: 'Signiere mit einer Browser-Erweiterung (Alby, nos2x-fox). Keine Netzwerklatenz — die Erweiterung signiert lokal.',
        connectBtn: 'Erweiterung verbinden',
        connecting: 'Verbinde mit Erweiterung …',
        connected: 'Mit Erweiterung verbunden',
        connectedAs: 'Angemeldet als',
        disconnect: 'Verbindung trennen',
        noExtensionError: 'Keine Nostr-Erweiterung gefunden. Installiere Alby oder nos2x-fox.',
        nip44MissingError: 'Diese Erweiterung unterstützt keine NIP-44-Verschlüsselung. Gruppenfunktionen erfordern NIP-44 (versuche Alby oder nos2x-fox).',
        reconnectError: 'Erweiterung nicht verfügbar. Bitte erneut verbinden.',
      },
    },
    calls: {
      incomingCallTitle: 'Eingehender Anruf',
      incomingVoiceCall: 'Sprachanruf',
      incomingVideoCall: 'Videoanruf',
      acceptCall: 'Annehmen',
      declineCall: 'Ablehnen',
      muteAudio: 'Stumm',
      unmuteAudio: 'Ton an',
      cameraOff: 'Kamera aus',
      cameraOn: 'Kamera an',
      hangUp: 'Auflegen',
      participants: (count: number) => `${count} Teilnehmer${count === 1 ? '' : ''}`,
      callConnected: 'Anruf verbunden',
      startVoiceCall: 'Sprachanruf starten',
      startVideoCall: 'Videoanruf starten',
      callDisabledGroupFull: 'Gruppe zu groß für Anrufe (max. 5)',
      callInProgress: 'Anruf läuft',
      callSettings: 'Anruf-Einstellungen',
      turnServerUrl: 'TURN-Server-URL',
      turnUsername: 'TURN-Benutzername',
      turnCredential: 'TURN-Zugangsdaten',
      saveTurnConfig: 'Speichern',
      ipPrivacyMode: 'IP-Datenschutz-Modus',
      turnHelp: 'Anrufe funktionieren standardmäßig über den öffentlichen openrelayproject-TURN-Relay – denselben, den auch Amethyst nutzt. Leer lassen, um ihn zu behalten, oder unten einen eigenen Relay eintragen.',
      ipPrivacyHelp: 'Medien über TURN leiten, um IP vor Teilnehmern zu verbergen (erhöht Latenz).',
      callStartedNotice: (callerName: string) => `${callerName} hat einen Anruf gestartet`,
      callEndedNotice: 'Anruf beendet',
    },
    scanner: {
      fabAriaLabel: 'QR-Code scannen',
      tabLabel: 'Scannen',
      title: 'QR-Code scannen',
      startingCamera: 'Kamera wird gestartet...',
      permissionDenied: 'Kamerazugriff wurde verweigert.',
      unavailable: 'QR-Scan ist auf diesem Gerät oder Browser nicht verfügbar.',
      unrecognisedLink: 'Dieser QR-Code ist keine few.chat-Kontaktkarte oder Gruppeneinladung.',
    },
  },
};

export function getCopy(language: LanguageCode): Copy {
  return copy[language];
}
