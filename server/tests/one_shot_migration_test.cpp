#include "liveplay/core/one_shot_migration.hpp"

#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>

using nlohmann::json;

namespace {

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

} // namespace

int main() {
    json doc{
        {"items", json::array({
            json{
                {"uuid", "playlist-group"},
                {"index", json::array({0})},
                {"displayName", "Program"},
                {"color", "#3300FF"},
                {"type", "group"},
                {"children", json::array({audio("playlist-a", "Existing cue", 0.8)})},
                {"startBehavior", json{{"action", "play-first"}}},
                {"endBehavior", json{{"action", "nothing"}}},
                {"isExpanded", true},
            },
        })},
        {"cartItems", json::array({
            json{{"slot", 5}, {"itemUuid", "cart-a"}, {"index", json::array({-1, 5})}},
            json{{"slot", 2}, {"itemUuid", "playlist-a"}, {"index", json::array({-1, 2})}},
        })},
        {"cartSlotKeys", json{
            {"2", json{{"key", "F3"}, {"ctrlKey", false}, {"shiftKey", false}, {"altKey", false}}},
            {"5", json{{"key", "F6"}, {"ctrlKey", false}, {"shiftKey", true}, {"altKey", false}}},
        }},
        {"cartOnlyItems", json::array({
            audio("cart-a", "Air horn", 1.2),
            audio("unbound", "Safety announcement", 0.6),
        })},
    };

    assert(liveplay::core::migrate_legacy_cart_to_one_shots(doc));
    assert(doc["cartItems"].empty());
    assert(doc["cartOnlyItems"].empty());
    assert(doc["cartSlotKeys"].empty());

    const auto* existing = find_item(doc["items"], "playlist-a");
    assert(existing);
    assert(liveplay::core::is_one_shot_cue(*existing));
    assert((*existing)["oneShot"]["order"] == 2);
    assert((*existing)["oneShot"]["retrigger"] == "restart");
    assert((*existing)["oneShot"]["hotkey"]["key"] == "F3");
    assert((*existing)["volume"] == 0.8);

    const auto* moved = find_item(doc["items"], "cart-a");
    assert(moved);
    assert(liveplay::core::is_one_shot_cue(*moved));
    assert((*moved)["oneShot"]["order"] == 5);
    assert((*moved)["oneShot"]["hotkey"]["key"] == "F6");
    assert((*moved)["volume"] == 1.2);
    assert((*moved)["mediaPath"] == "media/cue.wav");

    const auto* unbound = find_item(doc["items"], "unbound");
    assert(unbound);
    assert(liveplay::core::is_one_shot_cue(*unbound));
    assert((*unbound)["oneShot"]["order"] == 6);

    assert(doc["items"].size() == 2);
    const auto& migrated_group = doc["items"].back();
    assert(migrated_group["displayName"] == "One Shots");
    assert(migrated_group["children"].size() == 2);
    assert(migrated_group["index"] == json::array({1}));
    assert(migrated_group["children"][0]["index"] == json::array({1, 0}));
    assert(migrated_group["children"][1]["index"] == json::array({1, 1}));

    const json once = doc;
    assert(!liveplay::core::migrate_legacy_cart_to_one_shots(doc));
    assert(doc == once);

    const auto ordinary = audio("ordinary", "Ordinary cue");
    assert(!liveplay::core::is_one_shot_cue(ordinary));
}
