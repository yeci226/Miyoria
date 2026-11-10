package dev.miyoria.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.game.TaskTracker;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class TaskTrackerTest {
    private final List<String> out = new ArrayList<>();
    private final List<JsonObject> data = new ArrayList<>();
    private final TaskTracker tasks = new TaskTracker((name, d) -> {
        out.add(name + ":" + (d.has("code") ? d.get("code").getAsString() : d.get("task").getAsString()));
        data.add(d);
    });

    /** Emits like BridgeRuntime.emit: stamp, send, then the tracker sees it. */
    private JsonObject emit(String name, JsonObject d) {
        tasks.stamp(name, d);
        tasks.onEvent(name, d);
        return d;
    }

    private static JsonObject obj(String key, Object value) {
        JsonObject o = new JsonObject();
        if (value instanceof Boolean b) o.addProperty(key, b);
        else if (value instanceof Number n) o.addProperty(key, n);
        else if (value != null) o.addProperty(key, value.toString());
        return o;
    }

    @Test
    void gotoEndsOnTheGoalNotOnAnyPathEvent() {
        tasks.begin("t1", "goto");
        assertEquals(List.of("task_started:t1"), out);
        JsonObject reached = emit("goal_reached", obj("goal", "GoalBlock"));
        assertEquals("t1", reached.get("task").getAsString());
        assertEquals("task_done:t1", out.get(1));
        assertNull(tasks.current());
        // The idle after reaching it belongs to nothing any more.
        emit("baritone_idle", obj("cancelled", false));
        assertEquals(2, out.size());
    }

    @Test
    void miningTreatsPathSegmentsAsProgressAndEndsOnIdle() {
        tasks.begin("m1", "mine");
        emit("goal_reached", new JsonObject());
        emit("goal_failed", obj("reason", "no_path"));
        assertEquals(List.of("task_started:m1", "task_progress:m1"), out);
        emit("baritone_idle", obj("reason", "nothing_visible"));
        assertEquals("task_done:m1", out.get(2));
        assertEquals("nothing more in sight", data.get(2).get("detail").getAsString());
    }

    @Test
    void codesForEveryWayItCanFail() {
        tasks.begin("g1", "goto");
        emit("goal_failed", obj("reason", "no_path"));
        tasks.begin("m1", "mine");
        JsonObject idle = obj("cancelled", true);
        idle.addProperty("reason", "reflex");
        emit("baritone_idle", idle);
        tasks.begin("c1", "craft");
        emit("craft_failed", obj("error", "ran out of stick"));
        tasks.begin("s1", "smelt");
        emit("death", new JsonObject());
        tasks.begin("f1", "follow");
        emit("reflex", obj("interrupted", "Follow"));
        tasks.begin("e1", "explore");
        tasks.stopped();
        assertEquals(
                List.of("task_started:g1", "task_failed:unreachable", "task_started:m1", "task_failed:interrupted",
                        "task_started:c1", "task_failed:precondition", "task_started:s1", "task_failed:died",
                        "task_started:f1", "task_failed:interrupted", "task_started:e1", "task_failed:cancelled"),
                out);
        assertEquals("ran out of stick", data.get(5).get("message").getAsString());
    }

    @Test
    void aNewRequestSupersedesAndOneWithoutAnIdIsJustNotTracked() {
        tasks.begin("a", "mine");
        tasks.begin("b", "craft");
        // Crafting stopped Baritone: that idle is not the craft's end.
        emit("baritone_idle", obj("cancelled", true));
        assertEquals(List.of("task_started:a", "task_failed:superseded", "task_started:b"), out);
        JsonObject finished = emit("craft_finished", obj("crafted", 4));
        assertEquals("b", finished.get("task").getAsString());
        assertEquals("task_done:b", out.get(3));
        assertEquals(4, data.get(3).get("crafted").getAsInt());
        tasks.begin("c", "goto");
        tasks.begin(null, "goto");
        assertEquals("task_failed:superseded", out.get(5));
        assertNull(tasks.current());
        // Untracked events are not stamped.
        JsonObject plain = emit("goal_reached", new JsonObject());
        assertEquals(false, plain.has("task"));
    }

    @Test
    void altoClefEndsWhenAltoClefIsIdle() {
        tasks.begin("a1", "altoclef");
        emit("baritone_idle", obj("cancelled", false));
        tasks.altoTick(true);
        for (int i = 0; i < 9; i++) tasks.altoTick(false);
        assertEquals(1, out.size());
        tasks.altoTick(null);
        tasks.altoTick(false);
        assertEquals("task_done:a1", out.get(1));
        tasks.begin("a2", "altoclef");
        for (int i = 0; i < 100; i++) tasks.altoTick(false);
        assertEquals("task_done:a2", out.get(3));
    }
}
