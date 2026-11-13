package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.reflex.ReflexBrain;
import dev.miyoria.bridge.reflex.ReflexBrain.Kind;
import dev.miyoria.bridge.reflex.ReflexBrain.Sense;
import dev.miyoria.bridge.reflex.ReflexBrain.Step;
import dev.miyoria.bridge.reflex.ReflexBrain.Threat;
import dev.miyoria.bridge.util.Ids;
import dev.miyoria.bridge.util.LookMath;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.DeathScreen;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.type.FoodComponent;
import net.minecraft.entity.Entity;
import net.minecraft.entity.FallingBlockEntity;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.mob.Angerable;
import net.minecraft.entity.mob.CreeperEntity;
import net.minecraft.entity.mob.MobEntity;
import net.minecraft.entity.mob.Monster;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.AxeItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.item.SwordItem;
import net.minecraft.item.ToolItem;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.util.Hand;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The game side of the survival reflexes ({@link ReflexBrain} decides which one): samples what her
 * body feels every tick and does what the active reflex needs the way a player would: movement
 * keys, a hit on the mob in front of her when the swing has recharged, food from her own
 * inventory, Baritone for a longer walk. Every target is something she can see (no mob or drop
 * through a wall).
 *
 * <p>A reflex that takes over stops her task (Baritone, a craft / smelt job, a held key) and
 * reports {@code reflex} with what it interrupted; {@code reflex_end} follows. Client thread only.
 */
public final class Reflexes {
    private static final double THREAT_RADIUS = 12.0;
    private static final double PICKUP_RADIUS = 6.0;
    /** Survival attack reach. */
    private static final double REACH = 3.0;
    private static final float TURN_DEG_PER_TICK = 40f;
    /** Ticks between two AltoClef checks (reflection); AltoClef has its own reflexes. */
    private static final int ALTO_CHECK_TICKS = 20;
    /** Foods that hurt or teleport her; only eaten when starving. */
    private static final Set<Item> BAD_FOOD = Set.of(Items.ROTTEN_FLESH, Items.SPIDER_EYE, Items.POISONOUS_POTATO,
            Items.PUFFERFISH, Items.CHORUS_FRUIT, Items.SUSPICIOUS_STEW);
    private static final Sense INACTIVE = new Sense(false, false, false, false, 300, 300, false, false,
            20f, 20, false, null, false, false, false, 0, 0, 0, false);

    private final ReflexBrain brain;
    private final EventSink events;
    private final GameActions actions;
    private final Workbench workbench;
    private final AltoClefBridge alto;
    private final Set<KeyBinding> pressed = new HashSet<>();

    private long tickCount;
    private boolean altoBusy;

    // the active reflex
    private String interrupted;
    private int ticks;
    private Vec3d spot;
    private Entity target;
    private int restoreSlot = -1;
    /** Storage slot the food was swapped in from (-1: it was in the hotbar). */
    private int swappedFrom = -1;
    private int foodBefore;
    private int countBefore;
    private Item eating;
    private ItemEntity drop;
    private int dropTicks;
    private final Set<Integer> unreachable = new HashSet<>();
    private int unstuckAttempts;
    private Vec3d startPos;

    public Reflexes(ReflexBrain brain, EventSink events, GameActions actions, Workbench workbench, AltoClefBridge alto) {
        this.brain = brain;
        this.events = events;
        this.actions = actions;
        this.workbench = workbench;
        this.alto = alto;
    }

    /** Protocol id of the active reflex, or null. */
    public String active() {
        Kind k = brain.active();
        return k == null ? null : k.id();
    }

    /** Requests wait (are refused with {@code reflex_active}) while this is true. */
    public boolean blocksRequests() {
        return brain.blocksRequests();
    }

    /** A request or {@code stop} wants her body: a pickup (or another non-urgent reflex) gives way. */
    public void yieldTo(MinecraftClient mc, BaritoneBridge baritone) {
        Kind k = brain.yieldNonUrgent();
        if (k != null) {
            stop(mc, k, baritone);
            ended(k, false, true);
        }
    }

    public void tick(MinecraftClient mc, BaritoneBridge baritone) {
        tickCount++;
        if (mc.isPaused()) return; // single-player pause: the world stands still too
        ClientPlayerEntity p = mc.player;
        ClientWorld w = mc.world;
        boolean alive = p != null && w != null && p.isAlive() && !(mc.currentScreen instanceof DeathScreen);
        if (alto.available() && tickCount % ALTO_CHECK_TICKS == 0) {
            altoBusy = Boolean.TRUE.equals(alto.state().busy());
        }
        Sense s = alive && !altoBusy ? sense(mc, p, w, baritone) : INACTIVE;
        Step step = brain.tick(s);
        if (step.ended() != null) {
            stop(mc, step.ended(), baritone);
            ended(step.ended(), step.endedOk(), false);
        }
        if (step.started() != null) start(mc, p, w, step.started(), s, baritone);
        if (step.active() != null) {
            ticks++;
            run(mc, p, w, step.active(), baritone);
        }
    }

    // ------------------------------------------------------------------ sensing

    private Sense sense(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w, BaritoneBridge baritone) {
        boolean baritoneTask = baritone != null && baritone.state().busy() && !baritone.reflexDriving();
        boolean busy = baritoneTask || workbench.state() != null || actions.holding();
        int food = p.getHungerManager().getFoodLevel();
        // only looked up when they can matter (inventory and entity scans every tick add up)
        // a screen someone else opened (chat, a chest) would swallow the slot clicks of a meal
        boolean screenFree = mc.currentScreen == null || workbench.state() != null;
        boolean hasFood = screenFree && food <= brain.config().eatFood()
                && (bestFood(p, false) >= 0 || (food <= 4 && bestFood(p, true) >= 0));
        boolean drops = (!busy || brain.active() == Kind.PICKUP) && nearestDrop(p, w) != null;
        Entity threat = nearestThreat(p, w);
        return new Sense(true, p.isInLava(), w.getBlockState(p.getBlockPos()).isIn(BlockTags.FIRE),
                p.isSubmergedInWater(), p.getAir(), p.getMaxAir(), p.isInsideWall(), blockFalling(p, w),
                p.getHealth(), food, hasFood,
                threat == null ? null : new Threat(entityId(threat), threat.distanceTo(p), threat instanceof CreeperEntity),
                busy, baritoneTask && baritone.pathing(),
                mc.interactionManager != null && mc.interactionManager.isBreakingBlock(),
                p.getX(), p.getY(), p.getZ(), drops);
    }

    /**
     * A hostile that means her harm. Neutral ones (endermen, zombified piglins) only once they
     * attack: their anger itself is not known on the client.
     */
    private static boolean hostile(Entity e) {
        if (!(e instanceof Monster) || !e.isAlive()) return false;
        if (e instanceof Angerable) return e instanceof MobEntity m && m.isAttacking();
        return true;
    }

    /** The nearest hostile she can see. */
    private static Entity nearestThreat(ClientPlayerEntity p, ClientWorld w) {
        Box box = p.getBoundingBox().expand(THREAT_RADIUS);
        Entity best = null;
        double bestD = Double.MAX_VALUE;
        for (Entity e : w.getOtherEntities(p, box, Reflexes::hostile)) {
            double d = e.distanceTo(p);
            if (d > THREAT_RADIUS || d >= bestD || !p.canSee(e)) continue;
            best = e;
            bestD = d;
        }
        return best;
    }

    /** Hostiles near her, for running away from all of them. */
    private static List<BlockPos> threatPositions(ClientPlayerEntity p, ClientWorld w) {
        Box box = p.getBoundingBox().expand(THREAT_RADIUS);
        List<BlockPos> out = new ArrayList<>();
        for (Entity e : w.getOtherEntities(p, box, Reflexes::hostile)) out.add(e.getBlockPos());
        return out;
    }

    /** Sand / gravel / an anvil falling onto her column. */
    private static boolean blockFalling(ClientPlayerEntity p, ClientWorld w) {
        Box above = new Box(p.getX() - 0.9, p.getY(), p.getZ() - 0.9, p.getX() + 0.9, p.getY() + 10, p.getZ() + 0.9);
        return !w.getOtherEntities(p, above, e -> e instanceof FallingBlockEntity).isEmpty();
    }

    /** A dropped item she can see and pick up, nearest first. */
    private ItemEntity nearestDrop(ClientPlayerEntity p, ClientWorld w) {
        Box box = p.getBoundingBox().expand(PICKUP_RADIUS, 2, PICKUP_RADIUS);
        ItemEntity best = null;
        double bestD = Double.MAX_VALUE;
        for (Entity e : w.getOtherEntities(p, box, e -> e instanceof ItemEntity)) {
            ItemEntity item = (ItemEntity) e;
            if (item.cannotPickup() || unreachable.contains(item.getId())) continue;
            double d = item.distanceTo(p);
            if (d < bestD && p.canSee(item)) {
                best = item;
                bestD = d;
            }
        }
        return best;
    }

    /** Main inventory slot of the best food she has (most hunger restored); -1 when none. */
    private static int bestFood(ClientPlayerEntity p, boolean starving) {
        PlayerInventory inv = p.getInventory();
        int best = -1;
        int bestNutrition = 0;
        for (int i = 0; i < inv.main.size(); i++) {
            ItemStack s = inv.main.get(i);
            if (s.isEmpty()) continue;
            FoodComponent food = s.get(DataComponentTypes.FOOD);
            if (food == null || (!starving && BAD_FOOD.contains(s.getItem()))) continue;
            if (food.nutrition() > bestNutrition) {
                best = i;
                bestNutrition = food.nutrition();
            }
        }
        return best;
    }

    private static String entityId(Entity e) {
        return Ids.normalize(Registries.ENTITY_TYPE.getId(e.getType()).toString());
    }

    // ------------------------------------------------------------------ start / stop

    private void start(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w, Kind k, Sense s, BaritoneBridge baritone) {
        ticks = 0;
        spot = null;
        target = null;
        drop = null;
        eating = null;
        startPos = p.getPos();
        boolean stops = k.urgent || k == Kind.UNSTUCK || (k == Kind.EAT && s.busy());
        interrupted = stops ? currentTask(baritone) : null;
        int foodSlot = k == Kind.EAT ? bestFood(p, p.getHungerManager().getFoodLevel() <= 4) : -1;
        if (k == Kind.FIGHT || k == Kind.FLEE) target = nearestThreat(p, w);

        // Reported before the task is stopped, so whoever waits on that task knows why it ends.
        JsonObject d = new JsonObject();
        d.addProperty("kind", k.id());
        d.addProperty("interrupted", interrupted);
        d.addProperty("health", Math.round(p.getHealth() * 10f) / 10.0);
        if (target != null) d.addProperty("target", entityId(target));
        if (foodSlot >= 0) d.addProperty("food", Workbench.id(p.getInventory().main.get(foodSlot).getItem()));
        events.emit("reflex", d);
        if (stops) interrupt(mc, baritone);

        switch (k) {
            case FIGHT -> equipWeapon(mc, p);
            case EAT -> {
                if (foodSlot < 0) {
                    brain.finish(false);
                } else {
                    eating = p.getInventory().main.get(foodSlot).getItem();
                    foodBefore = p.getHungerManager().getFoodLevel();
                    countBefore = p.getInventory().count(eating);
                    restoreSlot = p.getInventory().selectedSlot;
                    swappedFrom = hold(mc, p, foodSlot);
                }
            }
            case UNSTUCK -> unstuckAttempts++;
            default -> {
            }
        }
    }

    /** What she is doing that a reflex would stop: a craft / smelt job, a Baritone process, a held key. */
    private String currentTask(BaritoneBridge baritone) {
        if (workbench.state() != null) return workbench.state().kind();
        if (baritone != null && baritone.state().busy() && !baritone.reflexDriving()) return baritone.state().process();
        return actions.holding() ? "hold" : null;
    }

    /** Stops her task: Baritone (reported as interrupted by a reflex), a craft / smelt job, held keys. */
    private void interrupt(MinecraftClient mc, BaritoneBridge baritone) {
        if (workbench.state() != null) workbench.cancel(mc);
        if (baritone != null && baritone.state().busy() && !baritone.reflexDriving()) baritone.interrupt();
        actions.releaseAll();
    }

    private void stop(MinecraftClient mc, Kind k, BaritoneBridge baritone) {
        release();
        ClientPlayerEntity p = mc.player;
        switch (k) {
            case FLEE, PICKUP -> {
                if (baritone != null) baritone.reflexCancel();
            }
            case SUFFOCATION -> {
                if (mc.interactionManager != null) mc.interactionManager.cancelBlockBreaking();
            }
            case EAT -> {
                if (p != null && mc.interactionManager != null) {
                    if (p.isUsingItem()) mc.interactionManager.stopUsingItem(p);
                    if (swappedFrom >= 0) {
                        // the same swap again puts the food and the hotbar item back where they were
                        mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, swappedFrom,
                                p.getInventory().selectedSlot, SlotActionType.SWAP, p);
                    }
                }
                if (p != null && restoreSlot >= 0) p.getInventory().selectedSlot = restoreSlot;
                restoreSlot = -1;
                swappedFrom = -1;
            }
            default -> {
            }
        }
        if (k != Kind.UNSTUCK) unstuckAttempts = 0;
        if (k == Kind.PICKUP) unreachable.clear();
    }

    /** {@code yielded}: it gave way to a request (not a failure). */
    private void ended(Kind k, boolean ok, boolean yielded) {
        JsonObject d = new JsonObject();
        d.addProperty("kind", k.id());
        d.addProperty("ok", ok);
        if (yielded) d.addProperty("yielded", true);
        d.addProperty("interrupted", interrupted);
        d.addProperty("secs", Math.round(ticks / 2.0) / 10.0);
        events.emit("reflex_end", d);
        interrupted = null;
    }

    // ------------------------------------------------------------------ doing

    private void run(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w, Kind k, BaritoneBridge baritone) {
        if (p == null || w == null) return;
        switch (k) {
            case LAVA -> {
                // A water bucket, once: using it again on the next ticks would scoop the water back up.
                if (ticks == 1 && mc.interactionManager != null) {
                    PlayerInventory inv = p.getInventory();
                    for (int i = 0; i < inv.main.size(); i++) {
                        if (inv.main.get(i).isOf(Items.WATER_BUCKET)) {
                            hold(mc, p, i);
                            p.setPitch(90f);
                            mc.interactionManager.interactItem(p, Hand.MAIN_HAND);
                            break;
                        }
                    }
                }
                // Keys, not Baritone: a path takes ticks to compute and she is burning.
                if (spot == null || ticks % 20 == 0) spot = safeSpot(p, w, 6, 0, null);
                moveToward(mc, p, spot, true);
            }
            case FALLING_BLOCK -> {
                if (spot == null) {
                    BlockPos column = p.getBlockPos();
                    spot = safeSpot(p, w, 2, 1, pos -> pos.getX() != column.getX() || pos.getZ() != column.getZ());
                }
                moveToward(mc, p, spot, false);
            }
            case SUFFOCATION -> {
                // dig out the block her head is stuck in, like holding left click on it
                BlockPos head = BlockPos.ofFloored(p.getEyePos());
                BlockPos at = w.getBlockState(head).getCollisionShape(w, head).isEmpty() ? p.getBlockPos() : head;
                if (mc.interactionManager != null) mc.interactionManager.updateBlockBreakingProgress(at, Direction.UP);
                p.swingHand(Hand.MAIN_HAND);

                // If suffocation continues beyond 5 ticks, backstep/move laterally toward an adjacent open block
                if (ticks > 5) {
                    BlockPos feet = p.getBlockPos();
                    BlockPos escape = null;
                    for (Direction d : Direction.values()) {
                        if (!d.getAxis().isHorizontal()) continue;
                        BlockPos adj = feet.offset(d);
                        if (free(w, adj) && free(w, adj.up())) {
                            escape = adj;
                            break;
                        }
                    }
                    if (escape != null) {
                        Vec3d targetVec = new Vec3d(escape.getX() + 0.5, escape.getY(), escape.getZ() + 0.5);
                        moveToward(mc, p, targetVec, false);
                    }
                }
            }
            case DROWNING -> press(mc.options.jumpKey);
            case FLEE -> {
                if (baritone != null) {
                    if (ticks % 40 == 1) {
                        List<BlockPos> from = threatPositions(p, w);
                        if (!from.isEmpty()) baritone.reflexRunAway(16, from);
                    }
                } else if (target != null) {
                    Vec3d away = p.getPos().multiply(2).subtract(target.getPos());
                    moveToward(mc, p, away, true);
                }
            }
            case FIGHT -> fight(mc, p, w);
            case EAT -> eat(mc, p);
            case UNSTUCK -> {
                if (spot == null) spot = safeSpot(p, w, 3, 2 + unstuckAttempts % 2, null);
                moveToward(mc, p, spot, true);
                if (ticks >= 20) brain.finish(p.getPos().distanceTo(startPos) > 1.0);
            }
            case PICKUP -> pickup(mc, p, w, baritone);
        }
    }

    private void fight(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w) {
        if (target == null || !target.isAlive() || target.distanceTo(p) > 8) target = nearestThreat(p, w);
        if (target == null) {
            release();
            return;
        }
        Vec3d aim = target.getPos().add(0, target.getHeight() * 0.6, 0);
        face(p, aim);
        double d = target.distanceTo(p);
        if (d > REACH - 0.3) press(mc.options.forwardKey);
        else releaseKey(mc.options.forwardKey);
        if (d <= REACH && p.getAttackCooldownProgress(0.5f) >= 0.95f && p.canSee(target) && mc.interactionManager != null) {
            mc.interactionManager.attackEntity(p, target);
            p.swingHand(Hand.MAIN_HAND);
        }
    }

    private void eat(MinecraftClient mc, ClientPlayerEntity p) {
        if (eating == null || mc.interactionManager == null) {
            brain.finish(false);
            return;
        }
        if (ticks == 1) {
            if (!p.getMainHandStack().isOf(eating) || !mc.interactionManager.interactItem(p, Hand.MAIN_HAND).isAccepted()) {
                brain.finish(false);
                return;
            }
        }
        press(mc.options.useKey); // keeps eating; letting go would stop it
        boolean ate = p.getHungerManager().getFoodLevel() > foodBefore || p.getInventory().count(eating) < countBefore;
        if (ticks > 5 && !p.isUsingItem()) brain.finish(ate);
        else if (ticks > 60) brain.finish(ate);
    }

    private void pickup(MinecraftClient mc, ClientPlayerEntity p, ClientWorld w, BaritoneBridge baritone) {
        if (drop == null || !drop.isAlive()) {
            drop = nearestDrop(p, w);
            dropTicks = 0;
            if (drop == null) {
                brain.finish(true);
                return;
            }
            if (baritone != null) baritone.reflexGoTo(drop.getBlockPos());
        }
        if (++dropTicks > 100) {
            // could not get to it: leave it
            unreachable.add(drop.getId());
            drop = null;
            if (baritone != null) baritone.reflexCancel();
            return;
        }
        if (baritone == null) moveToward(mc, p, drop.getPos(), false);
    }

    // ------------------------------------------------------------------ body

    /**
     * Puts {@code slot} of the main inventory in her hand. From the storage part it is swapped into
     * an empty hotbar slot (else the last one) so her tools stay in the hotbar; returns the storage
     * slot it came from (-1 when it was in the hotbar), for swapping it back.
     */
    private static int hold(MinecraftClient mc, ClientPlayerEntity p, int slot) {
        PlayerInventory inv = p.getInventory();
        if (slot < 9) {
            inv.selectedSlot = slot;
            return -1;
        }
        if (mc.interactionManager == null) return -1;
        int hotbar = 8;
        for (int i = 0; i < 9; i++) {
            if (inv.main.get(i).isEmpty()) {
                hotbar = i;
                break;
            }
        }
        // player screen handler slots 9-35 are inventory slots 9-35; SWAP's button is the hotbar slot
        mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, slot, hotbar, SlotActionType.SWAP, p);
        inv.selectedSlot = hotbar;
        return slot;
    }

    /** The best sword (else axe) of the hotbar in hand. */
    private static void equipWeapon(MinecraftClient mc, ClientPlayerEntity p) {
        PlayerInventory inv = p.getInventory();
        int best = -1;
        float bestScore = 0;
        for (int i = 0; i < 9; i++) {
            Item item = inv.main.get(i).getItem();
            float score = item instanceof SwordItem s ? 10 + s.getMaterial().getAttackDamage()
                    : item instanceof AxeItem a ? a.getMaterial().getAttackDamage()
                    : 0;
            if (score > bestScore) {
                best = i;
                bestScore = score;
            }
        }
        if (best >= 0) hold(mc, p, best);
    }

    private void face(ClientPlayerEntity p, Vec3d at) {
        Vec3d eye = p.getEyePos();
        LookMath.Rotation r = LookMath.toward(at.x - eye.x, at.y - eye.y, at.z - eye.z);
        p.setYaw(LookMath.approachAngle(p.getYaw(), r.yaw(), TURN_DEG_PER_TICK));
        p.setPitch(LookMath.clampPitch(LookMath.approachAngle(p.getPitch(), r.pitch(), TURN_DEG_PER_TICK)));
    }

    /** Walks (sprints) toward {@code to}, jumping when something is in the way or {@code jump}. */
    private void moveToward(MinecraftClient mc, ClientPlayerEntity p, Vec3d to, boolean jump) {
        if (to == null) {
            // nowhere safe in reach: keep going the way she faces
            press(mc.options.forwardKey);
            if (jump) press(mc.options.jumpKey);
            return;
        }
        Vec3d eye = p.getEyePos();
        LookMath.Rotation r = LookMath.toward(to.x - eye.x, 0, to.z - eye.z);
        p.setYaw(LookMath.approachAngle(p.getYaw(), r.yaw(), TURN_DEG_PER_TICK));
        double dx = to.x - p.getX(), dz = to.z - p.getZ();
        if (dx * dx + dz * dz < 0.09) {
            release();
            return;
        }
        press(mc.options.forwardKey);
        press(mc.options.sprintKey);
        if (jump || p.horizontalCollision || to.y > p.getY() + 0.5) press(mc.options.jumpKey);
        else releaseKey(mc.options.jumpKey);
    }

    /**
     * The nearest spot within {@code radius} she can stand on safely (solid ground that is not
     * magma, two free blocks without lava or fire), at least {@code minDistance} away; null when none.
     */
    private static Vec3d safeSpot(ClientPlayerEntity p, ClientWorld w, int radius, int minDistance,
                                  java.util.function.Predicate<BlockPos> extra) {
        BlockPos feet = p.getBlockPos();
        List<BlockPos> found = new ArrayList<>();
        for (int dx = -radius; dx <= radius; dx++) {
            for (int dz = -radius; dz <= radius; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) < minDistance) continue;
                for (int dy = -1; dy <= 2; dy++) {
                    BlockPos pos = feet.add(dx, dy, dz);
                    if (standable(w, pos) && (extra == null || extra.test(pos))) found.add(pos);
                }
            }
        }
        return found.stream()
                .min(Comparator.comparingDouble(pos -> pos.getSquaredDistance(p.getPos())))
                .map(pos -> new Vec3d(pos.getX() + 0.5, pos.getY(), pos.getZ() + 0.5))
                .orElse(null);
    }

    private static boolean standable(ClientWorld w, BlockPos pos) {
        BlockPos below = pos.down();
        BlockState under = w.getBlockState(below);
        if (!under.isSideSolidFullSquare(w, below, Direction.UP) || under.isOf(Blocks.MAGMA_BLOCK)) return false;
        return free(w, pos) && free(w, pos.up());
    }

    private static boolean free(ClientWorld w, BlockPos pos) {
        BlockState st = w.getBlockState(pos);
        return st.getCollisionShape(w, pos).isEmpty() && !st.isIn(BlockTags.FIRE)
                && !w.getFluidState(pos).isIn(FluidTags.LAVA);
    }

    private void press(KeyBinding key) {
        key.setPressed(true); // re-asserted every tick: losing focus resets pressed keys
        pressed.add(key);
    }

    private void releaseKey(KeyBinding key) {
        if (pressed.remove(key)) key.setPressed(false);
    }

    private void release() {
        for (KeyBinding k : pressed) k.setPressed(false);
        pressed.clear();
    }
}
