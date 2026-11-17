#pragma once

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace liveplay::core {

namespace quick_play_migration_detail {

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

inline bool contains_quick_play(const json& items) {
    if (!items.is_array()) return false;
    for (const auto& item : items) {
        if (!item.is_object()) continue;
        if (item.value("type", std::string{}) == "audio" &&
            item.contains("quickPlay") && item["quickPlay"].is_object()) {
            return true;
        }
        if (item.value("type", std::string{}) == "group" &&
            item.contains("children") && contains_quick_play(item["children"])) {
            return true;
        }
    }
    return false;
}

// The "-one-shot" suffix predates the QuickPlay name. It is part of an item
// id, which is saved data rather than a field name, so it stays: an old show
// gets the same ids whichever version first opens it.
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
    if (!item.contains("quickPlay") || !item["quickPlay"].is_object())
        item["quickPlay"] = json::object();
    auto& settings = item["quickPlay"];
    settings["order"] = order;
    if (!settings.contains("retrigger")) settings["retrigger"] = "restart";
    if (hotkey && hotkey->is_object()) settings["hotkey"] = *hotkey;
}

} // namespace quick_play_migration_detail

inline bool is_quick_play_cue(const nlohmann::json& item) {
    return item.is_object() && item.contains("quickPlay") &&
           item["quickPlay"].is_object();
}

// Upgrade both the removed fixed-slot model (slot bindings plus slot-only cues
// without QuickPlay settings) and the short-lived playlist-linked model to
// independent QuickPlay records. Playlist cues stay in the playlist and receive
// separate QuickPlay copies so editing either side cannot affect the other.
// The transform is idempotent. It runs after convert_legacy_quick_play_names(),
// so it only ever sees the current field names.
inline bool migrate_to_independent_quick_plays(nlohmann::json& doc) {
    using namespace quick_play_migration_detail;
    if (!doc.is_object()) return false;

    const bool has_bindings = doc.contains("quickPlaySlots") &&
        doc["quickPlaySlots"].is_array() && !doc["quickPlaySlots"].empty();
    const bool has_quick_play_items = doc.contains("quickPlayItems") &&
        doc["quickPlayItems"].is_array() && !doc["quickPlayItems"].empty();
    const bool has_unmarked_items = has_quick_play_items && std::any_of(
        doc["quickPlayItems"].begin(), doc["quickPlayItems"].end(),
        [](const json& item) {
            return !item.is_object() || !item.contains("quickPlay") ||
                   !item["quickPlay"].is_object();
        });
    const bool has_playlist_quick_plays = doc.contains("items") &&
        contains_quick_play(doc["items"]);
    if (!has_bindings && !has_unmarked_items && !has_playlist_quick_plays)
        return false;

    if (!doc.contains("items") || !doc["items"].is_array())
        doc["items"] = json::array();

    std::unordered_map<std::string, json*> playlist_by_uuid;
    std::unordered_set<std::string> all_uuids;
    std::vector<json*> playlist_traversal;
    collect_items(doc["items"], playlist_by_uuid, all_uuids,
                  playlist_traversal);

    std::unordered_map<std::string, json> unmarked_by_uuid;
    std::vector<std::string> unmarked_order;
    json independent_quick_plays = json::array();
    std::unordered_map<std::string, std::size_t> independent_by_uuid;
    if (has_quick_play_items) {
        for (const auto& item : doc["quickPlayItems"]) {
            if (!item.is_object()) continue;
            const auto uuid = item.value("uuid", std::string{});
            if (uuid.empty()) continue;
            if (is_quick_play_cue(item)) {
                independent_by_uuid.emplace(uuid, independent_quick_plays.size());
                independent_quick_plays.push_back(item);
                all_uuids.insert(uuid);
                continue;
            }
            if (unmarked_by_uuid.contains(uuid)) continue;
            unmarked_by_uuid.emplace(uuid, item);
            unmarked_order.push_back(uuid);
            all_uuids.insert(uuid);
        }
    }

    struct Binding { int slot; std::string uuid; };
    std::vector<Binding> bindings;
    if (has_bindings) {
        for (const auto& binding : doc["quickPlaySlots"]) {
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
        if (!doc.contains("quickPlaySlotKeys") || !doc["quickPlaySlotKeys"].is_object())
            return nullptr;
        const auto it = doc["quickPlaySlotKeys"].find(std::to_string(slot));
        return it == doc["quickPlaySlotKeys"].end() ? nullptr : &*it;
    };

    std::unordered_set<std::string> consumed;
    int next_order = 0;
    for (const auto& binding : bindings) {
        next_order = std::max(next_order, binding.slot + 1);
        if (const auto it = independent_by_uuid.find(binding.uuid);
            it != independent_by_uuid.end()) {
            mark(independent_quick_plays[it->second], binding.slot,
                 hotkey_for(binding.slot));
            continue;
        }
        if (auto it = playlist_by_uuid.find(binding.uuid);
            it != playlist_by_uuid.end() &&
            it->second->value("type", std::string{}) == "audio") {
            auto item = *it->second;
            item["uuid"] = independent_uuid(binding.uuid, all_uuids);
            mark(item, binding.slot, hotkey_for(binding.slot));
            item["quickPlay"]["sourceUuid"] = binding.uuid;
            item["index"] = json::array({-1, binding.slot});
            independent_quick_plays.push_back(std::move(item));
            it->second->erase("quickPlay");
            continue;
        }
        const auto unmarked_it = unmarked_by_uuid.find(binding.uuid);
        if (unmarked_it == unmarked_by_uuid.end() || consumed.contains(binding.uuid))
            continue;
        auto item = unmarked_it->second;
        mark(item, binding.slot, hotkey_for(binding.slot));
        item["index"] = json::array({-1, binding.slot});
        independent_quick_plays.push_back(std::move(item));
        consumed.insert(binding.uuid);
    }

    // Unbound slot-only cues are still user data. Preserve them after the
    // bound tiles instead of silently dropping them during migration.
    for (const auto& uuid : unmarked_order) {
        if (consumed.contains(uuid) || playlist_by_uuid.contains(uuid)) continue;
        auto item = unmarked_by_uuid.at(uuid);
        mark(item, next_order++);
        item["index"] = json::array({-1, item["quickPlay"]["order"]});
        independent_quick_plays.push_back(std::move(item));
    }

    // Decouple cues created by the previous playlist-linked QuickPlay model.
    for (auto* source : playlist_traversal) {
        if (!source || source->value("type", std::string{}) != "audio" ||
            !is_quick_play_cue(*source)) continue;
        const auto source_uuid = source->value("uuid", std::string{});
        auto item = *source;
        item["uuid"] = independent_uuid(source_uuid, all_uuids);
        if (!item["quickPlay"].contains("sourceUuid"))
            item["quickPlay"]["sourceUuid"] = source_uuid;
        independent_quick_plays.push_back(std::move(item));
        source->erase("quickPlay");
    }

    // Repair duplicate or invalid saved positions once, keeping the earliest
    // valid address and placing collisions in the first available cell.
    std::unordered_set<int> used_orders;
    int first_free = 0;
    for (auto& item : independent_quick_plays) {
        int order = -1;
        if (item.contains("quickPlay") && item["quickPlay"].is_object())
            order = item["quickPlay"].value("order", -1);
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
    doc["quickPlaySlots"] = json::array();
    doc["quickPlayItems"] = std::move(independent_quick_plays);
    doc["quickPlaySlotKeys"] = json::object();
    return true;
}

} // namespace liveplay::core
