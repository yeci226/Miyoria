// @miyoria/contracts/wire: the shapes every other contract is built from. Accounts, conversation
// contexts, messages as a platform delivered them, voice utterances, ids and times.
//
// snake_case field names; a value that can be missing is `T | null` with the key always present,
// except fields added after a shape was in use, which are optional (see kit/src/index.ts).

export {
  type ActionId,
  ActionIdSchema,
  type EventId,
  EventIdSchema,
  type ModuleId,
  ModuleIdSchema,
  type PersonId,
  PersonIdSchema,
  type PlatformId,
  PlatformIdSchema,
  type ProfileId,
  ProfileIdSchema,
  type Timestamp,
  TimestampSchema,
  type TurnId,
  TurnIdSchema,
} from "./ids.js";
export {
  type JsonObject,
  JsonObjectSchema,
  type JsonPrimitive,
  type JsonValue,
  JsonValueSchema,
} from "./json.js";
export {
  type AccountRef,
  AccountRefSchema,
  type Attachment,
  AttachmentSchema,
  type Author,
  AuthorSchema,
  type ContextKey,
  ContextKeySchema,
  type ContextKind,
  ContextKindSchema,
  type Embed,
  EmbedSchema,
  type ForwardedMessage,
  ForwardedMessageSchema,
  type IncomingMessage,
  IncomingMessageSchema,
  type MentionedAccount,
  MentionedAccountSchema,
  type MessageRef,
  MessageRefSchema,
  type QuotedMessage,
  QuotedMessageSchema,
  type Sticker,
  StickerSchema,
} from "./platform.js";
export {
  BOND_TIER_FLOORS,
  RELATIONSHIP_LABELS,
  type RelationshipLabel,
  TIER_STAGE_NUMERALS,
  type TierStage,
} from "./tiers.js";
export {
  type PlaybackState,
  PlaybackStateSchema,
  type VoiceParticipant,
  VoiceParticipantSchema,
  type VoiceTurnEnd,
  VoiceTurnEndSchema,
  type VoiceUtterance,
  VoiceUtteranceSchema,
} from "./voice.js";
