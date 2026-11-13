package dev.miyoria.bridge.protocol;

/** Constants of the miyoria-bridge wire protocol. See extensions/minecraft/PROTOCOL.md. */
public final class Protocol {
    private Protocol() {}

    public static final int VERSION = 1;

    // client -> server
    public static final String T_HELLO = "hello";
    public static final String T_PING = "ping";
    public static final String T_OBSERVE = "observe";
    public static final String T_BARITONE = "baritone";
    public static final String T_ALTOCLEF = "altoclef";
    public static final String T_CHAT = "chat";
    public static final String T_LOOK = "look";
    public static final String T_USE = "use";
    public static final String T_ATTACK = "attack";
    public static final String T_SELECT_SLOT = "select_slot";
    public static final String T_STOP = "stop";
    public static final String T_RESPAWN = "respawn";
    public static final String T_SCREENSHOT = "screenshot";
    public static final String T_CRAFT = "craft";
    public static final String T_SMELT = "smelt";
    public static final String T_PLACE = "place";
    public static final String T_DROP = "drop";
    /** Close the game the way the window's close button does (saves and leaves the world). */
    public static final String T_QUIT = "quit";

    // server -> client
    public static final String T_HELLO_ACK = "hello_ack";
    public static final String T_RESULT = "result";
    public static final String T_EVENT = "event";
    public static final String T_ERROR = "error";

    // error codes
    public static final String E_BAD_JSON = "bad_json";
    public static final String E_BAD_REQUEST = "bad_request";
    public static final String E_UNAUTHORIZED = "unauthorized";
    public static final String E_UNKNOWN_TYPE = "unknown_type";
    public static final String E_INVALID_ARGS = "invalid_args";
    public static final String E_NOT_IN_GAME = "not_in_game";
    /** Single-player is paused; Baritone block lookups would block the render thread forever. */
    public static final String E_GAME_PAUSED = "game_paused";
    public static final String E_BARITONE_UNAVAILABLE = "baritone_unavailable";
    public static final String E_ALTOCLEF_UNAVAILABLE = "altoclef_unavailable";
    public static final String E_SCREENSHOT_FAILED = "screenshot_failed";
    /** No block of that kind she can actually see nearby (no x-ray through Baritone's cache). */
    public static final String E_NOT_VISIBLE = "not_visible";
    /** She can see one, but it is too far to mine / use from here. */
    public static final String E_TOO_FAR = "too_far";
    /** The inventory lacks what the action needs; the message lists {@code item xN}. */
    public static final String E_MISSING_ITEMS = "missing_items";
    /** The recipe needs a crafting table (or the smelt a furnace) within reach. */
    public static final String E_NEEDS_STATION = "needs_station";
    /** A craft / smelt job is still running. */
    public static final String E_BUSY = "busy";
    /** A survival reflex (escaping lava, a fight...) has her body; try again when it ends. */
    public static final String E_REFLEX_ACTIVE = "reflex_active";
    public static final String E_INTERNAL = "internal";
}
