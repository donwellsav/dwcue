#pragma once

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace liveplay::core {

namespace one_shot_migration_detail {

using json = nlohmann::json;

inline void collect_items(json& items,
                          std::unordered_map<std::string, json*>& by_uuid,
                          std::unordered_set<std::string>& uuids) {
    if (!items.is_array()) return;
    for (auto& item : items) {
        if (!item.is_object()) continue;
        const auto uuid = item.value("uuid", std::string{});
        if (!uuid.empty()) {
            by_uuid.emplace(uuid, &item);
            uuids.insert(uuid);
        }
        if (item.value("type", std::string{}) == "group" &&
            item.contains("children")) {
            collect_items(item["children"], by_uuid, uuids);
        }
    }
}

inline void assign_indices(json& items, const std::vector<int>& parent = {}) {
    if (!items.is_array()) return;
    for (std::size_t i = 0; i < items.size(); ++i) {
        auto& item = items[i];
        if (!item.is_object()) continue;
        auto index = parent;
        index.push_back(static_cast<int>(i));
        item["index"] = index;
        if (item.value("type", std::string{}) == "group" &&
            item.contains("children")) {
            assign_indices(item["children"], index);
        }
    }
}

inline void mark(json& item, int order, const json* hotkey = nullptr) {
    if (!item.contains("oneShot") || !item["oneShot"].is_object())
        item["oneShot"] = json::object();
    auto& settings = item["oneShot"];
    settings["order"] = order;
    if (!settings.contains("retrigger")) settings["retrigger"] = "restart";
    if (hotkey && hotkey->is_object()) settings["hotkey"] = *hotkey;
}

} // namespace one_shot_migration_detail

inline bool is_one_shot_cue(const nlohmann::json& item) {
    return item.is_object() && item.contains("oneShot") &&
           item["oneShot"].is_object();
}

// Upgrade the removed fixed-slot Cart model to canonical playlist One Shots.
// Returns true only when legacy data was consumed. The transform is idempotent
// and deliberately keeps the old top-level keys empty for older clients.
inline bool migrate_legacy_cart_to_one_shots(nlohmann::json& doc) {
    using namespace one_shot_migration_detail;
    if (!doc.is_object()) return false;

    const bool has_bindings = doc.contains("cartItems") &&
        doc["cartItems"].is_array() && !doc["cartItems"].empty();
    const bool has_cart_only = doc.contains("cartOnlyItems") &&
        doc["cartOnlyItems"].is_array() && !doc["cartOnlyItems"].empty();
    if (!has_bindings && !has_cart_only) return false;

    if (!doc.contains("items") || !doc["items"].is_array())
        doc["items"] = json::array();

    std::unordered_map<std::string, json*> playlist_by_uuid;
    std::unordered_set<std::string> all_uuids;
    collect_items(doc["items"], playlist_by_uuid, all_uuids);

    std::unordered_map<std::string, json> cart_only_by_uuid;
    std::vector<std::string> cart_only_order;
    if (has_cart_only) {
        for (const auto& item : doc["cartOnlyItems"]) {
            if (!item.is_object()) continue;
            const auto uuid = item.value("uuid", std::string{});
            if (uuid.empty() || cart_only_by_uuid.contains(uuid)) continue;
            cart_only_by_uuid.emplace(uuid, item);
            cart_only_order.push_back(uuid);
            all_uuids.insert(uuid);
        }
    }

    struct Binding { int slot; std::string uuid; };
    std::vector<Binding> bindings;
    if (has_bindings) {
        for (const auto& binding : doc["cartItems"]) {
            if (!binding.is_object()) continue;
            const auto uuid = binding.value("itemUuid", std::string{});
            const int slot = binding.value("slot", -1);
            if (!uuid.empty() && slot >= 0) bindings.push_back({slot, uuid});
        }
        std::stable_sort(bindings.begin(), bindings.end(),
                         [](const Binding& a, const Binding& b) {
                             return a.slot < b.slot;
                         });
    }

    const auto hotkey_for = [&](int slot) -> const json* {
        if (!doc.contains("cartSlotKeys") || !doc["cartSlotKeys"].is_object())
            return nullptr;
        const auto it = doc["cartSlotKeys"].find(std::to_string(slot));
        return it == doc["cartSlotKeys"].end() ? nullptr : &*it;
    };

    json moved = json::array();
    std::unordered_set<std::string> consumed;
    int next_order = 0;
    for (const auto& binding : bindings) {
        next_order = std::max(next_order, binding.slot + 1);
        if (auto it = playlist_by_uuid.find(binding.uuid);
            it != playlist_by_uuid.end()) {
            mark(*it->second, binding.slot, hotkey_for(binding.slot));
            continue;
        }
        const auto cart_it = cart_only_by_uuid.find(binding.uuid);
        if (cart_it == cart_only_by_uuid.end() || consumed.contains(binding.uuid))
            continue;
        auto item = cart_it->second;
        mark(item, binding.slot, hotkey_for(binding.slot));
        moved.push_back(std::move(item));
        consumed.insert(binding.uuid);
    }

    // Unbound Cart-only cues are still user data. Preserve them after the
    // bound tiles instead of silently dropping them during migration.
    for (const auto& uuid : cart_only_order) {
        if (consumed.contains(uuid) || playlist_by_uuid.contains(uuid)) continue;
        auto item = cart_only_by_uuid.at(uuid);
        mark(item, next_order++);
        moved.push_back(std::move(item));
    }

    if (!moved.empty()) {
        std::string group_uuid = "one-shots";
        for (int suffix = 2; all_uuids.contains(group_uuid); ++suffix)
            group_uuid = "one-shots-" + std::to_string(suffix);
        doc["items"].push_back(json{
            {"uuid", std::move(group_uuid)},
            {"index", json::array()},
            {"displayName", "One Shots"},
            {"color", "#315FCF"},
            {"type", "group"},
            {"children", std::move(moved)},
            {"startBehavior", json{{"action", "play-first"}}},
            {"endBehavior", json{{"action", "nothing"}}},
            {"isExpanded", true},
        });
    }

    assign_indices(doc["items"]);
    doc["cartItems"] = json::array();
    doc["cartOnlyItems"] = json::array();
    doc["cartSlotKeys"] = json::object();
    return true;
}

} // namespace liveplay::core
