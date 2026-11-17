#pragma once

#include <nlohmann/json.hpp>

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
// the old one is dropped. Returns true when the object changed.
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
    changed |= rename_key(document, "cartOnlyItems", "quickPlayItems");
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
