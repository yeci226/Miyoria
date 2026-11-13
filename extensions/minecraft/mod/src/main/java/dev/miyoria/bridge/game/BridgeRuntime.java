package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.config.BridgeConfig;
import dev.miyoria.bridge.events.EventDetector;
import dev.miyoria.bridge.events.EventDetector.GameEvent;
import dev.miyoria.bridge.events.EventDetector.TickState;
import dev.miyoria.bridge.model.Models.EntityInfo;
import dev.miyoria.bridge.model.RawObservation;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.reflex.ReflexBrain;
import dev.miyoria.bridge.server.ActionHandler;
import dev.miyoria.bridge.server.BridgeServer;
import dev.miyoria.bridge.snapshot.SnapshotSummarizer;
import dev.miyoria.bridge.util.Ids;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.DeathScreen;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.damage.DamageSource;
import net.minecraft.registry.Registries;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Glue: owns the server and every game-facing component. Requests are marshalled onto the client
 * thread ({@code MinecraftClient.execute}); the per-tick pump produces pushed events.
 */
public final class BridgeRuntime implements ActionHandler {
    private static final Logger LOG = LoggerFactory.getLogger("miyoria-bridge");
    private static final String MOD_VERSION = FabricLoader.getInstance()
            .getModContainer("miyoria-bridge").map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("dev");

    private final BridgeConfig cfg;
    private final MinecraftClient mc = MinecraftClient.getInstance();
    private final BridgeServer server;
    private final GameObserver observer;
    private final GameActions actions = new GameActions();
    private final Workbench workbench;
    private final ScreenshotService screenshots;
    private final AltoClefBridge alto = new AltoClefBridge();
    private final EventDetector detector;
    private final SnapshotSummarizer.Options snapshotOptions;
    private final Reflexes reflexes;
    /** Lifecycle of work requests that carry a task id (PROTOCOL.md §6.1). */
    private final TaskTracker tasks;
    private BaritoneBridge baritone; // null when Baritone is not installed
    /** Requests that move her body; they wait while a reflex has it (see {@link #dispatch}). */
    private static final Set<String> BODY_REQUESTS = Set.of(Protocol.T_BARITONE, Protocol.T_ALTOCLEF, Protocol.T_LOOK,
            Protocol.T_USE, Protocol.T_ATTACK, Protocol.T_SELECT_SLOT, Protocol.T_PLACE, Protocol.T_CRAFT, Protocol.T_SMELT, Protocol.T_DROP);
    /** Off-client-thread Baritone block lookups (see {@link #handle}). */
    private static final ExecutorService PREWARM = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "miyoria-bridge-prewarm");
        t.setDaemon(true);
        return t;
    });

    private List<EntityInfo> hostileCache = List.of();
    private long tickCount;
    private int deadTicks;

    public BridgeRuntime(BridgeConfig cfg) {
        this.cfg = cfg;
        this.server = new BridgeServer(cfg.port, cfg.token, this);
        this.tasks = new TaskTracker(server::emitEvent);
        this.observer = new GameObserver(cfg);
        this.screenshots = new ScreenshotService(cfg.screenshotMaxWidth);
        this.detector = new EventDetector(new EventDetector.Config(cfg.lowHealthThreshold, cfg.hostileRadius, 100, 10));
        this.snapshotOptions = new SnapshotSummarizer.Options(cfg.maxEntities, cfg.maxBlockKinds);
        this.workbench = new Workbench(this::emit, actions);
        ReflexBrain.Config reflexCfg = new ReflexBrain.Config(cfg.reflexes, cfg.reflexFight, cfg.reflexPickup,
                cfg.reflexFleeHealth, cfg.reflexEatFood, cfg.reflexEatFoodBusy, cfg.reflexStuckSecs * 20);
        this.reflexes = new Reflexes(new ReflexBrain(reflexCfg), this::emit, actions, workbench, alto);

        if (FabricLoader.getInstance().isModLoaded("baritone")) {
            if (!baritoneApiPresent()) {
                // The class is only touched lazily, so without this check observe itself would
                // fail later with NoClassDefFoundError.
                LOG.error("Baritone is installed but baritone.api is missing: the \"standalone\" Baritone jar"
                        + " obfuscates its API. Put baritone-api-fabric-1.11.3.jar in mods/ instead;"
                        + " baritone actions disabled");
            } else {
                try {
                    this.baritone = new BaritoneBridgeImpl(this::emit, cfg.blockScanRadius);
                } catch (Throwable t) { // NoClassDefFoundError etc: wrong Baritone build
                    LOG.error("Baritone is installed but its API could not be loaded; baritone actions disabled", t);
                }
            }
        } else {
            LOG.warn("Baritone is not installed: movement/mining actions will answer baritone_unavailable");
        }
    }

    /** Whether Baritone's API classes exist under their real names (not obfuscated). */
    private static boolean baritoneApiPresent() {
        try {
            Class.forName("baritone.api.BaritoneAPI", false, BridgeRuntime.class.getClassLoader());
            return true;
        } catch (ClassNotFoundException | LinkageError e) {
            return false;
        }
    }

    public boolean start() throws InterruptedException {
        return server.startAndWait(5000);
    }

    public void shutdown() {
        screenshots.shutdown();
        server.shutdown();
    }

    public void emit(String name, JsonObject data) {
        tasks.stamp(name, data);
        server.emitEvent(name, data);
        tasks.onEvent(name, data);
    }

    public BridgeServer server() {
        return server;
    }

    // ------------------------------------------------------------------ ActionHandler

    @Override
    public JsonObject helloInfo() {
        JsonObject o = new JsonObject();
        o.addProperty("mod_version", MOD_VERSION);
        o.addProperty("minecraft", "1.21.1");
        JsonObject caps = new JsonObject();
        caps.addProperty("baritone", baritone != null);
        caps.addProperty("altoclef", alto.available());
        caps.addProperty("screenshot", true);
        // Work requests may carry a task id; its task_* lifecycle events follow (PROTOCOL.md §6.1).
        caps.addProperty("tasks", true);
        o.add("capabilities", caps);
        return o;
    }

    @Override
    public void handle(Request req, Responder out) {
        if (Protocol.T_PING.equals(req.type())) {
            JsonObject d = new JsonObject();
            d.addProperty("time", System.currentTimeMillis());
            out.ok(d);
            return;
        }
        if (Protocol.T_QUIT.equals(req.type())) {
            // Like the window's close button: the client leaves the world (saving it) and exits.
            mc.execute(() -> {
                JsonObject d = new JsonObject();
                d.addProperty("quitting", true);
                out.ok(d);
                LOG.info("closing the game (quit request)");
                mc.scheduleStop();
            });
            return;
        }
        // Baritone block lookups (mine) resolve on a worker first: on the client thread they wait on
        // a future the client thread itself has to run, and the game hangs for good.
        List<String> lookups =
                baritone != null && Protocol.T_BARITONE.equals(req.type()) ? baritone.lookupTargets(req) : List.of();
        if (!lookups.isEmpty()) {
            BaritoneBridge b = baritone;
            CompletableFuture.runAsync(() -> b.prewarm(lookups), PREWARM)
                    .orTimeout(30, TimeUnit.SECONDS)
                    .whenComplete((ok, err) -> {
                        if (err != null) {
                            LOG.warn("resolving {} for Baritone failed", lookups, err);
                            out.fail(Protocol.E_INTERNAL, "could not resolve blocks " + lookups + ": " + err);
                            return;
                        }
                        mc.execute(() -> run(req, out));
                    });
            return;
        }
        mc.execute(() -> run(req, out));
    }

    /** Client thread. */
    private void run(Request req, Responder out) {
        {
            try {
                dispatch(req, out);
            } catch (ProtocolException e) {
                out.fail(e.code(), e.getMessage());
            } catch (Throwable t) {
                LOG.warn("request {} failed", req.type(), t);
                out.fail(Protocol.E_INTERNAL, t.toString());
            }
        }
    }

    /** Client thread. */
    private void dispatch(Request req, Responder out) throws ProtocolException {
        if (mc.player == null || mc.world == null) {
            throw new ProtocolException(Protocol.E_NOT_IN_GAME, "no world loaded (main menu / loading)");
        }
        String task = taskId(req);
        if (BODY_REQUESTS.contains(req.type())) {
            // Escaping lava or fighting comes first; a pickup or a meal gives way to her request.
            if (reflexes.blocksRequests()) {
                throw new ProtocolException(Protocol.E_REFLEX_ACTIVE, "busy with a reflex: " + reflexes.active());
            }
            reflexes.yieldTo(mc, baritone);
        }
        switch (req.type()) {
            case Protocol.T_OBSERVE -> {
                RawObservation raw = observer.observe(baritone, alto);
                raw.crafting = workbench.state();
                raw.reflex = reflexes.active();
                out.ok(SnapshotSummarizer.summarize(raw, snapshotOptions));
            }
            case Protocol.T_BARITONE -> {
                if (baritone == null) {
                    throw new ProtocolException(Protocol.E_BARITONE_UNAVAILABLE, "Baritone is not installed");
                }
                JsonObject started = baritone.execute(req);
                out.ok(started);
                String command = req.str("command").toLowerCase();
                if (command.equals("stop") || command.equals("cancel")) tasks.stopped();
                else tasks.begin(task, command);
            }
            case Protocol.T_ALTOCLEF -> {
                String command = req.str("command");
                out.ok(alto.execute(command));
                String bare = command.trim().replaceFirst("^@", "").toLowerCase();
                if (bare.equals("stop")) tasks.stopped();
                else tasks.begin(task, "altoclef");
            }
            case Protocol.T_CHAT -> out.ok(actions.chat(mc, req));
            case Protocol.T_LOOK -> out.ok(actions.look(mc, req));
            case Protocol.T_USE -> out.ok(actions.use(mc, req));
            case Protocol.T_ATTACK -> out.ok(actions.attack(mc, req));
            case Protocol.T_SELECT_SLOT -> out.ok(actions.selectSlot(mc, req));
            case Protocol.T_PLACE -> out.ok(actions.place(mc, req));
            case Protocol.T_DROP -> out.ok(actions.drop(mc, req));
            case Protocol.T_CRAFT -> {
                JsonObject started = workbench.craft(mc, req);
                standStill();
                out.ok(started);
                tasks.begin(task, "craft");
            }
            case Protocol.T_SMELT -> {
                JsonObject started = workbench.smelt(mc, req);
                standStill();
                out.ok(started);
                tasks.begin(task, "smelt");
            }
            case Protocol.T_RESPAWN -> out.ok(actions.respawn(mc));
            case Protocol.T_STOP -> {
                out.ok(stopAll());
                tasks.stopped();
            }
            case Protocol.T_SCREENSHOT -> screenshots.capture(mc, req, out);
            default -> throw new ProtocolException(Protocol.E_UNKNOWN_TYPE, "unknown request type \"" + req.type() + "\"");
        }
    }

    /**
     * The optional {@code task} id of a work request (1-64 chars); checked before the work starts
     * so a bad id never leaves untracked work running.
     */
    private static String taskId(Request req) throws ProtocolException {
        String task = req.optStr("task", null);
        if (task != null && (task.isEmpty() || task.length() > 64)) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "\"task\" must be 1-64 chars");
        }
        return task;
    }

    /** A person stops walking to craft: cancel Baritone and let go of held keys. */
    private void standStill() {
        if (baritone != null && baritone.state().busy()) baritone.cancel();
        actions.releaseAll();
    }

    private JsonObject stopAll() {
        JsonObject o = new JsonObject();
        reflexes.yieldTo(mc, baritone); // survival reflexes keep going; a pickup or a meal stops
        workbench.cancel(mc);
        if (baritone != null) {
            baritone.cancel();
        }
        o.addProperty("baritone", baritone != null);
        alto.stop();
        o.addProperty("altoclef", alto.available());
        actions.releaseAll();
        return o;
    }

    // ------------------------------------------------------------------ tick pump (client thread)

    public void onEndTick(MinecraftClient client) {
        tickCount++;
        actions.tick(client);
        workbench.tick(client);

        ClientPlayerEntity p = client.player;
        boolean inWorld = p != null && client.world != null;

        if (inWorld && baritone != null) {
            try {
                baritone.tick();
            } catch (Throwable t) {
                if (tickCount % 200 == 0) LOG.debug("baritone tick failed", t);
            }
        }
        // An AltoClef task ends when AltoClef itself is idle (Baritone idles between its sub-tasks).
        if (inWorld && "altoclef".equals(tasks.kind())) {
            try {
                tasks.altoTick(alto.state().busy());
            } catch (Throwable t) {
                if (tickCount % 200 == 0) LOG.debug("altoclef task tick failed", t);
            }
        }

        // Her reflexes, only while she is connected: someone playing by hand keeps the controls.
        if (server.authenticatedClients() > 0) {
            try {
                reflexes.tick(client, baritone);
            } catch (Throwable t) {
                if (tickCount % 200 == 0) LOG.warn("reflex tick failed", t);
            }
        }

        if (server.authenticatedClients() == 0 && !inWorld) {
            detector.onTick(emptyState()); // keep the detector's baseline reset
            return;
        }

        boolean dead = inWorld && (p.isDead() || client.currentScreen instanceof DeathScreen);
        TickState state = inWorld ? sample(client, p, dead) : emptyState();
        for (GameEvent ev : detector.onTick(state)) {
            emit(ev.name(), ev.data());
        }

        if (dead && cfg.autoRespawn) {
            if (++deadTicks >= cfg.autoRespawnDelayTicks) {
                deadTicks = 0;
                p.requestRespawn();
            }
        } else {
            deadTicks = 0;
        }
    }

    private static TickState emptyState() {
        return new TickState(false, false, 0f, 0, Map.of(), "overworld", 0, 0, 0, 0, List.of(), null, null);
    }

    private TickState sample(MinecraftClient client, ClientPlayerEntity p, boolean dead) {
        RawObservation tmp = new RawObservation();
        observer.fillInventory(p, tmp);
        Map<String, Integer> inv = SnapshotSummarizer.inventoryTotals(tmp.mainSlots);

        // hostile scan only every 5 ticks (entity queries are the costly part)
        if (tickCount % 5 == 0) {
            hostileCache = observer.nearbyEntities(p, client.world, cfg.hostileRadius).stream()
                    .filter(EntityInfo::hostile).toList();
        }

        String src = null;
        String attacker = null;
        DamageSource ds = p.getRecentDamageSource();
        if (ds != null) {
            src = ds.getName();
            if (ds.getAttacker() != null) {
                attacker = ds.getAttacker() instanceof net.minecraft.entity.player.PlayerEntity pl
                        ? pl.getName().getString()
                        : Ids.normalize(Registries.ENTITY_TYPE.getId(ds.getAttacker().getType()).toString());
            }
        }

        return new TickState(true, dead, p.getHealth(), p.getHungerManager().getFoodLevel(), inv,
                Ids.normalize(client.world.getRegistryKey().getValue().toString()),
                client.world.getTimeOfDay(), p.getX(), p.getY(), p.getZ(),
                new ArrayList<>(hostileCache), src, attacker);
    }
}
