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
                          std::unordered_set<std::string>& uuids,
                          std::vector<json*>& traversal) {
    if (!items.is_array()) return;
    for (auto& item : items) {
        if (!item.is_object()) continue;
        const auto uuid = item.value("uuid", std::string{});
        if (!uuid.empty()) {
            by_uuid.emplace(uuid, &item);
            uuids.insert(uuid);
        }
        traversal.push_back(&item);
        if (item.value("type", std::string{}) == "group" &&
            item.contains("children")) {
            collect_items(item["children"], by_uuid, uuids, traversal);
        }
    }
}

inline bool contains_one_shot(const json& items) {
    if (!items.is_array()) return false;
    for (const auto& item : items) {
        if (!item.is_object()) continue;
        if (item.value("type", std::string{}) == "audio" &&
            item.contains("oneShot") && item["oneShot"].is_object()) {
            return true;
        }
        if (item.value("type", std::string{}) == "group" &&
            item.contains("children") && contains_one_shot(item["children"])) {
            return true;
        }
    }
    return false;
}

inline std::string independent_uuid(const std::string& source_uuid,
                                    std::unordered_set<std::string>& uuids) {
    const auto base = source_uuid.empty() ? std::string{"one-shot"}
                                          : source_uuid + "-one-shot";
    auto candidate = base;
    for (int suffix = 2; uuids.contains(candidate); ++suffix)
        candidate = base + "-" + std::to_string(suffix);
    uuids.insert(candidate);
    return candidate;
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

// Upgrade both removed fixed-slot Carts and the short-lived playlist-linked
// One Shot model to independent quick-play records. Playlist cues stay in the
// playlist and receive separate One Shot copies so editing either side cannot
// affect the other. The transform is idempotent.
inline bool migrate_legacy_cart_to_one_shots(nlohmann::json& doc) {
    using namespace one_shot_migration_detail;
    if (!doc.is_object()) return false;

    const bool has_bindings = doc.contains("cartItems") &&
        doc["cartItems"].is_array() && !doc["cartItems"].empty();
    const bool has_cart_only = doc.contains("cartOnlyItems") &&
        doc["cartOnlyItems"].is_array() && !doc["cartOnlyItems"].empty();
    const bool has_legacy_cart_only = has_cart_only && std::any_of(
        doc["cartOnlyItems"].begin(), doc["cartOnlyItems"].end(),
        [](const json& item) {
            return !item.is_object() || !item.contains("oneShot") ||
                   !item["oneShot"].is_object();
        });
    const bool has_playlist_one_shots = doc.contains("items") &&
        contains_one_shot(doc["items"]);
    if (!has_bindings && !has_legacy_cart_only && !has_playlist_one_shots)
        return false;

    if (!doc.contains("items") || !doc["items"].is_array())
        doc["items"] = json::array();

    std::unordered_map<std::string, json*> playlist_by_uuid;
    std::unordered_set<std::string> all_uuids;
    std::vector<json*> playlist_traversal;
    collect_items(doc["items"], playlist_by_uuid, all_uuids,
                  playlist_traversal);

    std::unordered_map<std::string, json> cart_only_by_uuid;
    std::vector<std::string> cart_only_order;
    json independent_one_shots = json::array();
    std::unordered_map<std::string, std::size_t> independent_by_uuid;
    if (has_cart_only) {
        for (const auto& item : doc["cartOnlyItems"]) {
            if (!item.is_object()) continue;
            const auto uuid = item.value("uuid", std::string{});
            if (uuid.empty()) continue;
            if (is_one_shot_cue(item)) {
                independent_by_uuid.emplace(uuid, independent_one_shots.size());
                independent_one_shots.push_back(item);
                all_uuids.insert(uuid);
                continue;
            }
            if (cart_only_by_uuid.contains(uuid)) continue;
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

    std::unordered_set<std::string> consumed;
    int next_order = 0;
    for (const auto& binding : bindings) {
        next_order = std::max(next_order, binding.slot + 1);
        if (const auto it = independent_by_uuid.find(binding.uuid);
            it != independent_by_uuid.end()) {
            mark(independent_one_shots[it->second], binding.slot,
                 hotkey_for(binding.slot));
            continue;
        }
        if (auto it = playlist_by_uuid.find(binding.uuid);
            it != playlist_by_uuid.end() &&
            it->second->value("type", std::string{}) == "audio") {
            auto item = *it->second;
            item["uuid"] = independent_uuid(binding.uuid, all_uuids);
            mark(item, binding.slot, hotkey_for(binding.slot));
            item["oneShot"]["sourceUuid"] = binding.uuid;
            item["index"] = json::array({-1, binding.slot});
            independent_one_shots.push_back(std::move(item));
            it->second->erase("oneShot");
            continue;
        }
        const auto cart_it = cart_only_by_uuid.find(binding.uuid);
        if (cart_it == cart_only_by_uuid.end() || consumed.contains(binding.uuid))
            continue;
        auto item = cart_it->second;
        mark(item, binding.slot, hotkey_for(binding.slot));
        item["index"] = json::array({-1, binding.slot});
        independent_one_shots.push_back(std::move(item));
        consumed.insert(binding.uuid);
    }

    // Unbound Cart-only cues are still user data. Preserve them after the
    // bound tiles instead of silently dropping them during migration.
    for (const auto& uuid : cart_only_order) {
        if (consumed.contains(uuid) || playlist_by_uuid.contains(uuid)) continue;
        auto item = cart_only_by_uuid.at(uuid);
        mark(item, next_order++);
        item["index"] = json::array({-1, item["oneShot"]["order"]});
        independent_one_shots.push_back(std::move(item));
    }

    // Decouple cues created by the previous playlist-linked One Shot model.
    for (auto* source : playlist_traversal) {
        if (!source || source->value("type", std::string{}) != "audio" ||
            !is_one_shot_cue(*source)) continue;
        const auto source_uuid = source->value("uuid", std::string{});
        auto item = *source;
        item["uuid"] = independent_uuid(source_uuid, all_uuids);
        if (!item["oneShot"].contains("sourceUuid"))
            item["oneShot"]["sourceUuid"] = source_uuid;
        independent_one_shots.push_back(std::move(item));
        source->erase("oneShot");
    }

    // Repair duplicate or invalid saved positions once, keeping the earliest
    // valid address and placing collisions in the first available cell.
    std::unordered_set<int> used_orders;
    int first_free = 0;
    for (auto& item : independent_one_shots) {
        int order = -1;
        if (item.contains("oneShot") && item["oneShot"].is_object())
            order = item["oneShot"].value("order", -1);
        if (order < 0 || order >= 256 || used_orders.contains(order)) {
            while (used_orders.contains(first_free)) ++first_free;
            order = first_free;
        }
        mark(item, order);
        item["index"] = json::array({-1, order});
        used_orders.insert(order);
        while (used_orders.contains(first_free)) ++first_free;
    }

    assign_indices(doc["items"]);
    doc["cartItems"] = json::array();
    doc["cartOnlyItems"] = std::move(independent_one_shots);
    doc["cartSlotKeys"] = json::object();
    return true;
}

} // namespace liveplay::core
