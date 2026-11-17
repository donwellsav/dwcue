#pragma once

#include <nlohmann/json.hpp>

#include <string>
#include <unordered_set>
#include <utility>

namespace liveplay::core {

// Shows saved before QuickPlay had its own name call it "cart" and "one shot".
// This header is the only place in the engine that knows those old names.
// Every show document passes through convert_legacy_quick_play_names() as it
// enters the engine (open, archive import, backup restore, a document pushed
// by a client), so the rest of the engine reads and writes only the current
// names and a saved show never contains an old one.
//
//   document  cartOnlyItems  -> quickPlayItems
//   document  cartItems      -> quickPlaySlots
//   document  cartSlotKeys   -> quickPlaySlotKeys
//   settings  cartSlotCount  -> quickPlaySlotCount
//   per item  oneShot        -> quickPlay
namespace legacy_quick_play_names_detail {

using json = nlohmann::json;

// Moves `old_name` to `new_name`. When both exist the current name wins and
// the old one is dropped (the list of QuickPlay cues is the exception, see
// merge_item_lists). Returns true when the object changed.
inline bool rename_key(json& object, const char* old_name, const char* new_name) {
    const auto old_field = object.find(old_name);
    if (old_field == object.end()) return false;
    if (!object.contains(new_name)) {
        json value = std::move(*old_field);
        object.erase(old_name);
        object[new_name] = std::move(value);
    } else {
        object.erase(old_name);
    }
    return true;
}

// The list of QuickPlay cues is the one thing that is merged rather than
// replaced. Both lists exist only when an older version saved a show this
// version made: it kept our list untouched, could not show it, and wrote its
// own beside it. Every cue in either list is kept. The older version's come
// first and keep their cells, because that is the arrangement the operator saw
// last; one of ours whose cell is now taken moves to the first free cell. A
// cue already in the list (same uuid) is not added twice.
inline bool merge_item_lists(json& object, const char* old_name, const char* new_name) {
    const auto old_field = object.find(old_name);
    const auto new_field = object.find(new_name);
    if (old_field == object.end() || new_field == object.end() ||
        !old_field->is_array() || !new_field->is_array()) {
        return rename_key(object, old_name, new_name);
    }
    json merged = std::move(*old_field);
    json current = std::move(*new_field);
    const auto uuid_of = [](const json& item) {
        const auto uuid = item.is_object() ? item.find("uuid") : item.end();
        return item.is_object() && uuid != item.end() && uuid->is_string()
            ? uuid->get<std::string>() : std::string{};
    };
    // A cue's QuickPlay settings, under whichever name it still has here.
    const auto settings_of = [](json& item) -> json* {
        if (!item.is_object()) return nullptr;
        for (const char* name : {"quickPlay", "oneShot"}) {
            if (const auto field = item.find(name); field != item.end() && field->is_object())
                return &*field;
        }
        return nullptr;
    };
    const auto cell_of = [](const json& settings) {
        const auto order = settings.find("order");
        return order != settings.end() && order->is_number_integer() ? order->get<int>() : -1;
    };
    std::unordered_set<std::string> present;
    std::unordered_set<int> taken;
    for (auto& item : merged) {
        if (auto uuid = uuid_of(item); !uuid.empty()) present.insert(std::move(uuid));
        if (const auto* settings = settings_of(item)) taken.insert(cell_of(*settings));
    }
    int first_free = 0;
    for (auto& item : current) {
        const auto uuid = uuid_of(item);
        if (!uuid.empty() && present.contains(uuid)) continue;
        if (auto* settings = settings_of(item)) {
            int cell = cell_of(*settings);
            if (cell < 0 || taken.contains(cell)) {
                while (taken.contains(first_free)) ++first_free;
                cell = first_free;
                (*settings)["order"] = cell;
                item["index"] = json::array({-1, cell});
            }
            taken.insert(cell);
        }
        merged.push_back(std::move(item));
    }
    object.erase(old_name);
    object[new_name] = std::move(merged);
    return true;
}

// Items nest: a group holds its cues in `children`, to any depth.
inline bool rename_item_keys(json& items) {
    if (!items.is_array()) return false;
    bool changed = false;
    for (auto& item : items) {
        if (!item.is_object()) continue;
        changed |= rename_key(item, "oneShot", "quickPlay");
        if (const auto children = item.find("children"); children != item.end())
            changed |= rename_item_keys(*children);
    }
    return changed;
}

} // namespace legacy_quick_play_names_detail

// True when a document carries one of the old top-level names. Used only to
// recognise an old show as a show before it has been converted.
inline bool has_legacy_quick_play_names(const nlohmann::json& document) {
    return document.is_object() &&
           (document.contains("cartItems") ||
            document.contains("cartSlotKeys") ||
            document.contains("cartOnlyItems"));
}

// The conversion step. Renames every old name to its current one, in place,
// without changing any value. Idempotent; returns true when anything changed.
inline bool convert_legacy_quick_play_names(nlohmann::json& document) {
    using namespace legacy_quick_play_names_detail;
    if (!document.is_object()) return false;

    bool changed = false;
    changed |= merge_item_lists(document, "cartOnlyItems", "quickPlayItems");
    changed |= rename_key(document, "cartItems", "quickPlaySlots");
    changed |= rename_key(document, "cartSlotKeys", "quickPlaySlotKeys");
    if (const auto settings = document.find("settings");
        settings != document.end() && settings->is_object()) {
        changed |= rename_key(*settings, "cartSlotCount", "quickPlaySlotCount");
    }
    for (const char* list : {"items", "quickPlayItems"}) {
        if (const auto items = document.find(list); items != document.end())
            changed |= rename_item_keys(*items);
    }
    return changed;
}

} // namespace liveplay::core
