#include "liveplay/core/legacy_quick_play_names.hpp"
#include "liveplay/core/quick_play_migration.hpp"

#ifdef NDEBUG
#undef NDEBUG
#endif
#include <algorithm>
#include <cassert>
#include <cctype>
#include <string>

using nlohmann::json;

namespace {

// The field names a show uses. Shows saved before the QuickPlay rename use
// kOldNames; everything the engine holds, serves and saves uses kNewNames.
struct Names {
    const char* quick_play_items;
    const char* slots;
    const char* slot_keys;
    const char* slot_count;
    const char* item_settings;
};
constexpr Names kOldNames{"cartOnlyItems", "cartItems", "cartSlotKeys", "cartSlotCount", "oneShot"};
constexpr Names kNewNames{"quickPlayItems", "quickPlaySlots", "quickPlaySlotKeys",
                          "quickPlaySlotCount", "quickPlay"};

json audio(std::string uuid, std::string name, double volume = 1.0) {
    return json{
        {"uuid", std::move(uuid)},
        {"index", json::array()},
        {"displayName", std::move(name)},
        {"color", "#00CC99"},
        {"type", "audio"},
        {"mediaFileName", "cue.wav"},
        {"mediaPath", "media/cue.wav"},
        {"volume", volume},
        {"endBehavior", json{{"action", "nothing"}}},
        {"duckingBehavior", json{{"mode", "duck-others"}, {"duckLevel", 0.1}}},
    };
}

json group(std::string uuid, json children) {
    return json{
        {"uuid", std::move(uuid)},
        {"index", json::array({0})},
        {"displayName", "Program"},
        {"color", "#3300FF"},
        {"type", "group"},
        {"children", std::move(children)},
        {"startBehavior", json{{"action", "play-first"}}},
        {"endBehavior", json{{"action", "nothing"}}},
        {"isExpanded", true},
    };
}

const json* find_item(const json& items, const std::string& uuid) {
    for (const auto& item : items) {
        if (item.value("uuid", std::string{}) == uuid) return &item;
        if (item.value("type", std::string{}) == "group" &&
            item.contains("children") && item["children"].is_array()) {
            if (const auto* found = find_item(item["children"], uuid))
                return found;
        }
    }
    return nullptr;
}

// True when any object key, at any depth, still says "cart" or "oneShot".
bool has_old_name(const json& value) {
    if (value.is_object()) {
        for (const auto& [key, child] : value.items()) {
            std::string lower = key;
            std::transform(lower.begin(), lower.end(), lower.begin(),
                           [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
            if (lower.find("cart") != std::string::npos ||
                lower.find("oneshot") != std::string::npos) {
                return true;
            }
            if (has_old_name(child)) return true;
        }
    } else if (value.is_array()) {
        for (const auto& child : value)
            if (has_old_name(child)) return true;
    }
    return false;
}

// One show using every renamed field: the QuickPlay item list with an item
// carrying QuickPlay settings, slot assignments, slot keys, the settings slot
// count, and a playlist cue inside a nested group carrying QuickPlay settings.
json every_renamed_field(const Names& names) {
    auto pad = audio("pad", "Air horn", 1.2);
    pad[names.item_settings] = json{
        {"order", 4}, {"retrigger", "ignore"},
        {"hotkey", json{{"key", "F6"}, {"ctrlKey", false}, {"shiftKey", true}, {"altKey", false}}},
    };
    auto nested = audio("nested", "Old linked tile", 0.7);
    nested[names.item_settings] = json{{"order", 3}, {"retrigger", "restart"}, {"sourceUuid", "elsewhere"}};
    return json{
        {"name", "Old show"},
        {"version", "2.0.0"},
        {"items", json::array({
            group("outer", json::array({
                audio("plain", "Existing cue", 0.8),
                group("inner", json::array({std::move(nested)})),
            })),
        })},
        {names.slots, json::array({
            json{{"slot", 5}, {"itemUuid", "pad"}, {"index", json::array({-1, 5})}},
        })},
        {names.slot_keys, json{
            {"5", json{{"key", "F6"}, {"ctrlKey", false}, {"shiftKey", true}, {"altKey", false}}},
        }},
        {names.quick_play_items, json::array({std::move(pad), audio("unmarked", "Safety announcement", 0.6)})},
        {"settings", json{{names.slot_count, 24}, {"autoSave", false}}},
        {"theme", json{{"mode", "dark"}, {"accentColor", "#123456"}}},
    };
}

void legacy_names_become_current_names_with_the_same_content() {
    const json current = every_renamed_field(kNewNames);
    json converted = every_renamed_field(kOldNames);
    assert(has_old_name(converted));
    assert(liveplay::core::has_legacy_quick_play_names(converted));

    assert(liveplay::core::convert_legacy_quick_play_names(converted));
    assert(converted == current);
    assert(!has_old_name(converted));
    assert(!liveplay::core::has_legacy_quick_play_names(converted));
    assert(converted["items"][0]["children"][1]["children"][0]["quickPlay"]["sourceUuid"] == "elsewhere");
    assert(converted["quickPlayItems"][0]["quickPlay"]["hotkey"]["key"] == "F6");
    assert(converted["settings"]["quickPlaySlotCount"] == 24);

    // Converting again, or converting a show that already uses the current
    // names, changes nothing.
    assert(!liveplay::core::convert_legacy_quick_play_names(converted));
    assert(converted == current);
}

void current_name_wins_when_a_document_has_both() {
    auto item = audio("both", "Both names");
    item["oneShot"] = json{{"order", 1}};
    item["quickPlay"] = json{{"order", 2}};
    json doc{
        {"items", json::array({std::move(item)})},
        {"cartOnlyItems", json::array({audio("old-list", "Old list")})},
        {"quickPlayItems", json::array({audio("new-list", "New list")})},
        {"cartItems", json::array({json{{"slot", 1}, {"itemUuid", "old-list"}}})},
        {"quickPlaySlots", json::array()},
        {"cartSlotKeys", json{{"1", json{{"key", "F1"}}}}},
        {"quickPlaySlotKeys", json{{"2", json{{"key", "F2"}}}}},
        {"settings", json{{"cartSlotCount", 8}, {"quickPlaySlotCount", 32}}},
    };

    assert(liveplay::core::convert_legacy_quick_play_names(doc));
    assert(!has_old_name(doc));
    assert(doc["items"][0]["quickPlay"]["order"] == 2);
    // The two lists of cues are the exception: nothing in either is dropped.
    assert(doc["quickPlayItems"].size() == 2);
    assert(doc["quickPlayItems"][0]["uuid"] == "old-list");
    assert(doc["quickPlayItems"][1]["uuid"] == "new-list");
    assert(doc["quickPlaySlots"].empty());
    assert(doc["quickPlaySlotKeys"].size() == 1 && doc["quickPlaySlotKeys"].contains("2"));
    assert(doc["settings"]["quickPlaySlotCount"] == 32);
}

// An older version opens a show this version saved: it cannot see our list,
// keeps it in the file, and writes its own beside it. Coming back, every
// QuickPlay made on either side is still there.
void quick_plays_made_in_an_older_version_are_kept_beside_ours() {
    auto made_in_old = audio("made-in-old", "Made in the older version");
    made_in_old["oneShot"] = json{{"order", 0}};
    auto ours_a = audio("ours-a", "Ours A");
    ours_a["quickPlay"] = json{{"order", 0}};
    auto ours_b = audio("ours-b", "Ours B");
    ours_b["quickPlay"] = json{{"order", 1}};
    auto seen_by_both = audio("ours-b", "Ours B as the older version kept it");
    seen_by_both["oneShot"] = json{{"order", 4}};
    json doc{
        {"items", json::array()},
        {"cartOnlyItems", json::array({made_in_old, seen_by_both})},
        {"quickPlayItems", json::array({ours_a, ours_b})},
    };

    assert(liveplay::core::convert_legacy_quick_play_names(doc));
    assert(!has_old_name(doc));
    const auto& list = doc["quickPlayItems"];
    assert(list.size() == 3);
    // The older version's arrangement comes first; a cue in both is not doubled.
    assert(list[0]["uuid"] == "made-in-old" && list[0]["quickPlay"]["order"] == 0);
    assert(list[1]["uuid"] == "ours-b" && list[1]["quickPlay"]["order"] == 4);
    // Ours wanted cell 0, which the older version's cue now has: first free cell.
    assert(list[2]["uuid"] == "ours-a" && list[2]["quickPlay"]["order"] == 1);
    assert(list[2]["index"] == json::array({-1, 1}));

    // The usual case: the older version made none, so it wrote an empty list.
    json untouched{
        {"cartOnlyItems", json::array()},
        {"quickPlayItems", json::array({ours_a, ours_b})},
    };
    assert(liveplay::core::convert_legacy_quick_play_names(untouched));
    assert(untouched == json({{"quickPlayItems", json::array({ours_a, ours_b})}}));

    // A list that is not a list is not merged: the current name wins.
    json broken{{"cartOnlyItems", "not a list"}, {"quickPlayItems", json::array({ours_a})}};
    assert(liveplay::core::convert_legacy_quick_play_names(broken));
    assert(broken == json({{"quickPlayItems", json::array({ours_a})}}));
}

void conversion_ignores_documents_it_does_not_understand() {
    json not_a_show = json::array({1, 2, 3});
    assert(!liveplay::core::convert_legacy_quick_play_names(not_a_show));
    assert(!liveplay::core::has_legacy_quick_play_names(not_a_show));

    json odd{{"items", "not an array"}, {"settings", 7}, {"cartOnlyItems", json::array({"text", 4})}};
    assert(liveplay::core::convert_legacy_quick_play_names(odd));
    assert(odd == (json{{"items", "not an array"}, {"settings", 7},
                        {"quickPlayItems", json::array({"text", 4})}}));
}

// The fixed-slot and playlist-linked models that older versions saved.
json slot_era_show(const Names& names) {
    auto linked = audio("linked", "Old linked tile", 0.7);
    linked[names.item_settings] = json{{"order", 3}, {"retrigger", "ignore"}};
    auto independent = audio("independent", "Walk-in announcement", 0.9);
    independent[names.item_settings] = json{{"order", 999999}, {"retrigger", "ignore"}};
    return json{
        {"items", json::array({
            group("playlist-group", json::array({
                audio("playlist-a", "Existing cue", 0.8),
                std::move(linked),
            })),
        })},
        {names.slots, json::array({
            json{{"slot", 5}, {"itemUuid", "pad-a"}, {"index", json::array({-1, 5})}},
            json{{"slot", 2}, {"itemUuid", "playlist-a"}, {"index", json::array({-1, 2})}},
        })},
        {names.slot_keys, json{
            {"2", json{{"key", "F3"}, {"ctrlKey", false}, {"shiftKey", false}, {"altKey", false}}},
            {"5", json{{"key", "F6"}, {"ctrlKey", false}, {"shiftKey", true}, {"altKey", false}}},
        }},
        {names.quick_play_items, json::array({
            audio("pad-a", "Air horn", 1.2),
            audio("unbound", "Safety announcement", 0.6),
            std::move(independent),
        })},
    };
}

void slot_era_shows_become_independent_quick_plays() {
    json doc = slot_era_show(kOldNames);
    assert(liveplay::core::convert_legacy_quick_play_names(doc));
    assert(doc == slot_era_show(kNewNames));

    assert(liveplay::core::migrate_to_independent_quick_plays(doc));
    assert(!has_old_name(doc));
    assert(doc["quickPlaySlots"].empty());
    assert(doc["quickPlayItems"].size() == 5);
    assert(doc["quickPlaySlotKeys"].empty());

    const auto* existing = find_item(doc["items"], "playlist-a");
    assert(existing);
    assert(!liveplay::core::is_quick_play_cue(*existing));
    assert((*existing)["volume"] == 0.8);

    const auto* existing_copy = find_item(doc["quickPlayItems"], "playlist-a-one-shot");
    assert(existing_copy);
    assert((*existing_copy)["quickPlay"]["sourceUuid"] == "playlist-a");
    assert((*existing_copy)["quickPlay"]["order"] == 2);
    assert((*existing_copy)["quickPlay"]["hotkey"]["key"] == "F3");

    const auto* moved = find_item(doc["quickPlayItems"], "pad-a");
    assert(moved);
    assert(liveplay::core::is_quick_play_cue(*moved));
    assert((*moved)["quickPlay"]["order"] == 5);
    assert((*moved)["quickPlay"]["hotkey"]["key"] == "F6");
    assert((*moved)["volume"] == 1.2);
    assert((*moved)["mediaPath"] == "media/cue.wav");

    const auto* unbound = find_item(doc["quickPlayItems"], "unbound");
    assert(unbound);
    assert(liveplay::core::is_quick_play_cue(*unbound));
    assert((*unbound)["quickPlay"]["order"] == 6);

    const auto* linked = find_item(doc["items"], "linked");
    assert(linked);
    assert(!liveplay::core::is_quick_play_cue(*linked));
    const auto* linked_copy = find_item(doc["quickPlayItems"], "linked-one-shot");
    assert(linked_copy);
    assert((*linked_copy)["quickPlay"]["sourceUuid"] == "linked");
    assert((*linked_copy)["quickPlay"]["order"] == 3);
    assert((*linked_copy)["quickPlay"]["retrigger"] == "ignore");

    const auto* independent = find_item(doc["quickPlayItems"], "independent");
    assert(independent);
    assert((*independent)["quickPlay"]["order"] == 0);

    assert(doc["items"].size() == 1);
    assert(doc["items"][0]["children"].size() == 2);
    assert(doc["items"][0]["index"] == json::array({0}));
    assert(doc["items"][0]["children"][0]["index"] == json::array({0, 0}));
    assert(doc["items"][0]["children"][1]["index"] == json::array({0, 1}));

    const json once = doc;
    assert(!liveplay::core::migrate_to_independent_quick_plays(doc));
    assert(doc == once);

    // The same show written with the current names migrates to the same result.
    json current = slot_era_show(kNewNames);
    assert(!liveplay::core::convert_legacy_quick_play_names(current));
    assert(liveplay::core::migrate_to_independent_quick_plays(current));
    assert(current == once);

    const auto ordinary = audio("ordinary", "Ordinary cue");
    assert(!liveplay::core::is_quick_play_cue(ordinary));
}

} // namespace

int main() {
    legacy_names_become_current_names_with_the_same_content();
    current_name_wins_when_a_document_has_both();
    quick_plays_made_in_an_older_version_are_kept_beside_ours();
    conversion_ignores_documents_it_does_not_understand();
    slot_era_shows_become_independent_quick_plays();
}
