// Closing the helper's stdin restores the HDMI link and releases Quartz modes.
// All display calls run off the show's UI process.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ColorSync/ColorSync.h>
#import <IOKit/graphics/IOGraphicsTypes.h>
#include <math.h>
#include <signal.h>
#include <unistd.h>

static NSString *displayUUID(CGDirectDisplayID display) {
    CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(display);
    if (!uuid) return nil;
    NSString *text = CFBridgingRelease(CFUUIDCreateString(NULL, uuid));
    CFRelease(uuid);
    return text;
}

static NSArray<NSNumber *> *onlineDisplays(void) {
    uint32_t count = 0;
    if (CGGetOnlineDisplayList(0, NULL, &count) || !count) return @[];
    NSMutableData *buffer = [NSMutableData dataWithLength:count * sizeof(CGDirectDisplayID)];
    CGDirectDisplayID *ids = buffer.mutableBytes;
    if (CGGetOnlineDisplayList(count, ids, &count)) return @[];
    NSMutableArray *result = [NSMutableArray array];
    for (uint32_t i = 0; i < count; ++i) [result addObject:@(ids[i])];
    return result;
}

static CGDirectDisplayID findDisplay(NSString *uuid) {
    if (!uuid) return 0;
    CGDirectDisplayID found = 0;
    for (NSNumber *number in onlineDisplays()) {
        if ([uuid isEqualToString:displayUUID(number.unsignedIntValue)]) {
            if (found) return 0;
            found = number.unsignedIntValue;
        }
    }
    return found;
}

static NSString *broadcastFormat(size_t w, size_t h, uint32_t flags, double hz) {
    // Drivers report either the rational rate or its conventional decimal name
    // in 16.16 fixed point. Allow one unit of that representation.
    static const struct { double hz; const char *label; } rates[] = {
        {24000./1001, "23.976"}, {24, "24"}, {25, "25"}, {30000./1001, "29.97"},
        {30, "30"}, {50, "50"}, {60000./1001, "59.94"}, {60, "60.00"}
    };
    const BOOL interlaced = (flags & kDisplayModeInterlacedFlag) != 0;
    if (!isfinite(hz) || !(flags & kDisplayModeTelevisionFlag) || !(flags & kDisplayModeValidFlag) ||
        (flags & (kDisplayModeStretchedFlag | kDisplayModeRequiresPanFlag | kDisplayModeNeverShowFlag))) return nil;
    const BOOL sd = (h == 480 || h == 576) && (w == 720 || (w == 1440 && interlaced));
    if (!sd && !(w == 1280 && h == 720 && !interlaced) && !(w == 1920 && h == 1080) &&
        !(w == 3840 && h == 2160 && !interlaced)) return nil;
    for (size_t i = 0; i < sizeof(rates)/sizeof(rates[0]); ++i) {
        double decimalName = round(rates[i].hz * 1000) / 1000;
        if (fmin(fabs(hz - rates[i].hz), fabs(hz - decimalName)) > 1./65536) continue;
        // Interlaced presets require an explicit field-rate readout. An
        // ambiguous 29.97 report cannot establish a 59.94-field signal.
        if ((interlaced || sd) && rates[i].hz < 50) return nil;
        if ((h == 480 && rates[i].hz == 50) || (h == 576 && rates[i].hz != 50)) return nil;
        return [NSString stringWithFormat:@"%zu%c%s", h, interlaced ? 'i' : 'p', rates[i].label];
    }
    return nil;
}

#ifndef DWCUE_TEST_HDMI
#import "mac_hdmi_connection.h"
#endif

static NSString *formatOf(CGDisplayModeRef mode) {
    if (!mode || CGDisplayModeGetPixelWidth(mode) != CGDisplayModeGetWidth(mode) ||
        CGDisplayModeGetPixelHeight(mode) != CGDisplayModeGetHeight(mode)) return nil;
    return broadcastFormat(CGDisplayModeGetPixelWidth(mode), CGDisplayModeGetPixelHeight(mode),
                           CGDisplayModeGetIOFlags(mode), CGDisplayModeGetRefreshRate(mode));
}

static NSDictionary *reportedMode(CGDisplayModeRef mode) {
    if (!mode) return @{};
    double hz = CGDisplayModeGetRefreshRate(mode);
    NSString *format = formatOf(mode);
    return @{@"modeId": @(CGDisplayModeGetIODisplayModeID(mode)),
             @"width": @(CGDisplayModeGetPixelWidth(mode)), @"height": @(CGDisplayModeGetPixelHeight(mode)),
             @"logicalWidth": @(CGDisplayModeGetWidth(mode)), @"logicalHeight": @(CGDisplayModeGetHeight(mode)),
             @"flags": @(CGDisplayModeGetIOFlags(mode)),
             @"interlaced": @((CGDisplayModeGetIOFlags(mode) & kDisplayModeInterlacedFlag) != 0),
             @"hz": @(isfinite(hz) ? hz : 0), @"format": format ? format : @""};
}

static NSString *nativeKey(CGDisplayModeRef mode, NSString *uuid) {
    if (!mode || !uuid) return nil;
    uint32_t flags = CGDisplayModeGetIOFlags(mode);
    double hz = CGDisplayModeGetRefreshRate(mode);
    if (!isfinite(hz) || hz <= 0 || hz > 1000 || !(flags & kDisplayModeValidFlag) || !(flags & kDisplayModeSafeFlag)
        || (flags & (kDisplayModeRequiresPanFlag | kDisplayModeStretchedFlag | kDisplayModeNeverShowFlag))
        || CGDisplayModeGetWidth(mode) != CGDisplayModeGetPixelWidth(mode)
        || CGDisplayModeGetHeight(mode) != CGDisplayModeGetPixelHeight(mode)) return nil;
    return [NSString stringWithFormat:@"native:%@:%x:%zux%zu%c:%lld", uuid, (unsigned)CGDisplayModeGetIODisplayModeID(mode),
            CGDisplayModeGetPixelWidth(mode), CGDisplayModeGetPixelHeight(mode),
            (flags & kDisplayModeInterlacedFlag) ? 'i' : 'p', llround(hz * 1000000)];
}

static NSString *chooseFormat(NSString *request, NSArray *formats) {
    if (![request isEqual:@"auto"]) return [formats containsObject:request] ? request : nil;
    for (NSString *name in @[@"1080p59.94", @"1080i59.94", @"720p59.94", @"480i59.94", @"480p59.94"]) {
        if ([formats containsObject:name]) return name;
    }
    return nil;
}

static CGError setMode(CGDirectDisplayID displayID, CGDisplayModeRef mode) {
    CGDisplayConfigRef change = NULL;
    CGError error = CGBeginDisplayConfiguration(&change);
    if (error) return error;
    error = CGConfigureDisplayWithDisplayMode(change, displayID, mode, NULL);
    if (error) { CGCancelDisplayConfiguration(change); return error; }
    return CGCompleteDisplayConfiguration(change, kCGConfigureForAppOnly);
}

static NSString *targetUUID, *requested, *chosen;
static CGDirectDisplayID controlID, lastDisplay;
static BOOL enabled, applyFailed, restoreFailed;
static NSInteger revision;
static NSDictionary *originalMode, *ownedMode, *approvedMode, *lastReport;
static BOOL ownedConnectionMode;

static BOOL eligible(CGDirectDisplayID displayID) {
    return displayID && controlID && displayID != controlID && CGDisplayIsActive(displayID) && !CGDisplayIsBuiltin(displayID)
        && !CGDisplayIsInMirrorSet(displayID) && !CGDisplayIsInHWMirrorSet(displayID);
}

static NSArray *displayModes(CGDirectDisplayID displayID) {
    NSDictionary *options = @{ (__bridge NSString *)kCGDisplayShowDuplicateLowResolutionModes: @YES };
    NSArray *modes = CFBridgingRelease(CGDisplayCopyAllDisplayModes(displayID, (__bridge CFDictionaryRef)options));
    return modes ? modes : @[];
}

static BOOL stillAssigned(CGDirectDisplayID displayID) {
    return eligible(displayID) && displayID == findDisplay(targetUUID);
}

static NSDictionary *snapshot(CGDisplayModeRef mode, NSDictionary *link) {
    if (!mode) return nil;
    return @{@"desktop": reportedMode(mode), @"link": link ? link : NSNull.null};
}

static NSDictionary *readSnapshot(CGDirectDisplayID displayID) {
    if (!stillAssigned(displayID)) return nil;
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(displayID);
    NSDictionary *state = snapshot(mode, hdmiLink(displayID));
    if (mode) CGDisplayModeRelease(mode);
    return state;
}

static NSDictionary *linkOf(NSDictionary *state) {
    id link = state[@"link"];
    return link == NSNull.null ? nil : link;
}

static BOOL sameConnection(NSDictionary *first, NSDictionary *second) {
    NSDictionary *a = linkOf(first), *b = linkOf(second);
    return [a[@"uuid"] isEqual:b[@"uuid"]] && [a[@"signal"] isEqual:b[@"signal"]] && [a[@"mode"] isEqual:b[@"mode"]];
}

static BOOL ownsReading(NSDictionary *state) {
    return [state isEqual:ownedMode] || (ownedConnectionMode && sameConnection(ownedMode, state));
}

static void report(CGDirectDisplayID displayID, NSString *phase, NSArray *formats, NSDictionary *otherModes,
                   NSDictionary *active, BOOL present) {
    NSMutableDictionary *actual = [active[@"desktop"] mutableCopy];
    if (!actual) actual = [NSMutableDictionary dictionary];
    NSDictionary *link = linkOf(active);
    if (link) {
        NSDictionary *signal = link[@"signal"];
        [actual addEntriesFromDictionary:signal.count ? signal : @{@"hz": @0, @"format": @""}];
    }
    NSDictionary *state = @{@"revision": @(revision), @"id": displayID ? @(displayID).stringValue : [NSNull null],
        @"phase": phase, @"restoreFailed": @(restoreFailed), @"formats": formats, @"nativeModes": otherModes, @"actual": actual,
        @"chosen": chosen ? chosen : @"", @"uuid": targetUUID ? targetUUID : @"", @"canPresent": @(present)};
    if ([lastReport isEqual:state]) return;
    lastReport = state;
    NSData *data = [NSJSONSerialization dataWithJSONObject:state options:0 error:NULL];
    if (data) { fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); }
}

static NSDictionary *settled(CGDirectDisplayID displayID, BOOL (^matches)(NSDictionary *)) {
    NSDictionary *previous = nil;
    for (int sample = 0; sample < 16; ++sample) {
        NSDictionary *state = readSnapshot(displayID);
        if (!state) return nil;
        if (matches(state)) {
            if ([state isEqual:previous]) return state;
            previous = state;
        } else {
            previous = nil;
        }
        usleep(50000);
    }
    return nil;
}

static BOOL setConnection(CGDirectDisplayID displayID, NSDictionary *link, NSDictionary *description) {
    if (!stillAssigned(displayID) || !description.count) return NO;
    id display = hdmiDisplay(displayID);
    if (!display || ![[[display UUID] description] isEqual:link[@"uuid"]]) return NO;
    id mode = hdmiMode(display, description);
    if (!mode || !stillAssigned(displayID) || ![hdmiLink(displayID)[@"uuid"] isEqual:link[@"uuid"]]) return NO;
    [display setCurrentMode:mode];
    return YES;
}

static BOOL restoreState(CGDirectDisplayID displayID, NSDictionary *state) {
    NSDictionary *now = readSnapshot(displayID);
    if (!now) return NO;
    NSDictionary *desktop = state[@"desktop"];
    if (![now[@"desktop"] isEqual:desktop]) {
        BOOL applied = NO;
        for (id entry in displayModes(displayID)) {
            CGDisplayModeRef mode = (__bridge CGDisplayModeRef)entry;
            if (![reportedMode(mode) isEqual:desktop]) continue;
            applied = stillAssigned(displayID) && !setMode(displayID, mode);
            break;
        }
        if (!applied || !settled(displayID, ^BOOL(NSDictionary *observed) {
            return [observed[@"desktop"] isEqual:desktop];
        })) return NO;
        now = readSnapshot(displayID);
    }
    NSDictionary *link = linkOf(state);
    if (link && ![linkOf(now) isEqual:link] && !setConnection(displayID, link, link[@"mode"])) return NO;
    return settled(displayID, ^BOOL(NSDictionary *observed) { return [observed isEqual:state]; }) != nil;
}

static void restoreOriginal(void) {
    if (!originalMode) return;
    CGDirectDisplayID displayID = findDisplay(targetUUID);
    NSDictionary *state = readSnapshot(displayID);
    if ([state isEqual:ownedMode]) {
        restoreFailed = !restoreState(displayID, originalMode);
    } else if (ownsReading(state) && !sameConnection(state, originalMode)) {
        // WindowServer can change the desktop mode ID independently of the
        // HDMI link. Undo Cue's connection change without touching that mode.
        NSDictionary *link = linkOf(originalMode);
        restoreFailed = !setConnection(displayID, link, link[@"mode"]) ||
            !settled(displayID, ^BOOL(NSDictionary *observed) { return sameConnection(observed, originalMode); });
    }
    originalMode = nil;
    ownedMode = nil;
    ownedConnectionMode = NO;
}

static void inspect(BOOL allowChange) {
    CGDirectDisplayID displayID = findDisplay(targetUUID);
    if (!eligible(displayID)) {
        approvedMode = nil;
        chosen = nil;
        lastDisplay = 0;
        report(displayID, displayID ? @"protected" : @"missing", @[], @{}, NULL, NO);
        return;
    }
    BOOL attached = displayID != lastDisplay;
    if (attached) approvedMode = nil;
    if (allowChange || attached) applyFailed = NO;
    lastDisplay = displayID;
    CGDisplayModeRef active = CGDisplayCopyDisplayMode(displayID);
    NSArray *modes = displayModes(displayID);
    if (active) modes = [modes arrayByAddingObject:(__bridge id)active];
    NSMutableDictionary *available = [NSMutableDictionary dictionary];
    NSMutableDictionary *otherModes = [NSMutableDictionary dictionary];
    for (id entry in modes) {
        CGDisplayModeRef mode = (__bridge CGDisplayModeRef)entry;
        NSString *name = formatOf(mode);
        if (name && (!available[name] || mode == active)) available[name] = entry;
        NSString *key = nativeKey(mode, targetUUID);
        if (key) {
            available[key] = entry;
            otherModes[key] = [NSString stringWithFormat:@"%zu×%zu%c · %.6f Hz · #%x", CGDisplayModeGetPixelWidth(mode),
                CGDisplayModeGetPixelHeight(mode), CGDisplayModeGetIOFlags(mode) & kDisplayModeInterlacedFlag ? 'i' : 'p',
                CGDisplayModeGetRefreshRate(mode), (unsigned)CGDisplayModeGetIODisplayModeID(mode)];
        }
    }
    NSDictionary *link = hdmiLink(displayID);
    NSDictionary *state = snapshot(active, link);
    NSDictionary *exactConnection = exact1080Connection(displayID, link);
    NSMutableArray *formats = [NSMutableArray array];
    for (NSString *name in available) if (![name hasPrefix:@"native:"]) [formats addObject:name];
    if (exactConnection && ![formats containsObject:@"1080p59.94"]) [formats addObject:@"1080p59.94"];
    [formats sortUsingSelector:@selector(localizedStandardCompare:)];
    BOOL native = [requested hasPrefix:@"native:"];
    if (!chosen || allowChange || attached) chosen = chooseFormat(requested, [formats arrayByAddingObjectsFromArray:otherModes.allKeys]);
    NSString *phase = restoreFailed ? @"restoreFailed" : @"idle";
    if (enabled && [requested isEqual:@"current"]) {
        phase = state ? @"current" : @"unavailable";
        approvedMode = state;
    } else if (enabled) {
        CGDisplayModeRef next = chosen ? (__bridge CGDisplayModeRef)available[chosen] : NULL;
        BOOL exact = [chosen isEqual:@"1080p59.94"];
        NSString *actual = native ? nativeKey(active, targetUUID) : link && exact ? link[@"signal"][@"format"] : formatOf(active);
        BOOL hasMode = next || (exact && exactConnection);
        if ((allowChange || attached) && state && hasMode && stillAssigned(displayID)) {
            NSDictionary *desiredDesktop = reportedMode(next);
            NSDictionary *candidate = exact && !next ? exactConnection : nil;
            // With a connection override, applying the same desktop mode may
            // be a no-op. Re-select its original link before trying another mode.
            BOOL resetLink = !candidate && [state isEqual:ownedMode] && linkOf(originalMode) &&
                ![linkOf(originalMode) isEqual:link] && [originalMode[@"desktop"] isEqual:state[@"desktop"]];
            BOOL changed = [chosen isEqual:actual] && !resetLink;
            if (!changed && candidate) changed = setConnection(displayID, link, candidate);
            else if (!changed && !candidate) {
                changed = (!resetLink || restoreState(displayID, originalMode)) &&
                    stillAssigned(displayID) && !setMode(displayID, next);
            }
            NSDictionary *verified = changed ? settled(displayID, ^BOOL(NSDictionary *observed) {
                if ((candidate || (exact && link)) &&
                    ![linkOf(observed)[@"signal"][@"format"] isEqual:@"1080p59.94"]) return NO;
                return candidate ? [linkOf(observed)[@"mode"] isEqual:candidate] : [observed[@"desktop"] isEqual:desiredDesktop];
            }) : nil;
            if (verified) {
                if (![state isEqual:verified]) {
                    if (!originalMode || (!attached && !ownsReading(state))) originalMode = state;
                    ownedMode = verified;
                    ownedConnectionMode = candidate != nil;
                }
                state = verified;
                actual = chosen;
            } else {
                applyFailed = YES;
                NSDictionary *now = readSnapshot(displayID);
                if (now && ![now isEqual:state] && !restoreState(displayID, state)) {
                    if (!originalMode || (!attached && !ownsReading(state))) originalMode = state;
                    ownedMode = readSnapshot(displayID);
                    ownedConnectionMode = candidate != nil;
                    approvedMode = nil;
                }
                state = readSnapshot(displayID);
            }
        }
        if (!applyFailed && chosen && [chosen isEqual:actual]) {
            phase = @"matched";
            approvedMode = state;
        } else {
            phase = applyFailed ? @"failed" : hasMode ? @"mismatch" : @"unavailable";
        }
    }
    BOOL present = enabled && state && [approvedMode isEqual:state] && stillAssigned(displayID);
    report(displayID, phase, formats, otherModes, state, present);
    if (active) CGDisplayModeRelease(active);
}

static unsigned timingRetryGeneration;

static BOOL awaitingTiming(void) {
    NSString *phase = lastReport[@"phase"];
    return enabled && ![requested isEqual:@"current"] &&
        ([phase isEqual:@"missing"] || [phase isEqual:@"unavailable"] || [phase isEqual:@"mismatch"]);
}

static void recheckTiming(unsigned generation, unsigned attempts) {
    if (!attempts || !awaitingTiming()) return;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        if (generation != timingRetryGeneration || !awaitingTiming()) return;
        inspect(YES);
        recheckTiming(generation, attempts - 1);
    });
}

static void configure(NSDictionary *command) {
    controlID = [command[@"control"] unsignedIntValue];
    restoreFailed = NO;
    if ([command[@"assign"] boolValue]) {
        restoreOriginal();
        CGDirectDisplayID displayID = [command[@"id"] unsignedIntValue];
        NSString *saved = command[@"uuid"];
        targetUUID = saved.length ? saved : ([onlineDisplays() containsObject:@(displayID)] ? displayUUID(displayID) : nil);
        lastDisplay = 0;
        approvedMode = nil;
        chosen = nil;
    }
    BOOL nextEnabled = [command[@"enabled"] boolValue];
    if (enabled && !nextEnabled) { restoreOriginal(); approvedMode = nil; chosen = nil; }
    if (![requested isEqual:command[@"format"]]) {
        chosen = nil;
        applyFailed = NO;
    }
    requested = command[@"format"];
    enabled = nextEnabled;
    revision = [command[@"revision"] integerValue];
    inspect([command[@"apply"] boolValue]);
    // EDID and connection modes can arrive after the initial display event.
    recheckTiming(++timingRetryGeneration, 12);
}

static void changed(CGDirectDisplayID display, CGDisplayChangeSummaryFlags flags, void *context) {
    if (flags & kCGDisplayBeginConfigurationFlag) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        if ((flags & kCGDisplayRemoveFlag) && display == lastDisplay && display != findDisplay(targetUUID)) {
            lastDisplay = 0;
            approvedMode = nil;
            chosen = nil;
        }
        static unsigned generation;
        unsigned event = ++generation;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 180 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            if (event == generation && revision) {
                inspect(NO);
                if (awaitingTiming()) recheckTiming(++timingRetryGeneration, 12);
            }
        });
    });
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc == 2 && !strcmp(argv[1], "--self-test")) {
            uint32_t p = kDisplayModeTelevisionFlag | kDisplayModeValidFlag, i = p | kDisplayModeInterlacedFlag;
            return !([broadcastFormat(1920,1080,p,59.93999) isEqual:@"1080p59.94"]
                && [broadcastFormat(1920,1080,p,60) isEqual:@"1080p60.00"]
                && [broadcastFormat(1920,1080,i,59.94) isEqual:@"1080i59.94"]
                && [broadcastFormat(1440,480,i,59.94) isEqual:@"480i59.94"]
                && [broadcastFormat(1920,1080,i,50) isEqual:@"1080i50"]
                && [broadcastFormat(3840,2160,p,24000./1001) isEqual:@"2160p23.976"]
                && !broadcastFormat(1920,1080,i,29.97) && !broadcastFormat(640,480,p,59.94)
                && !broadcastFormat(1920,1080,p,0) && !broadcastFormat(1920,1080,p,59.97)
                && !broadcastFormat(1920,1080,p,59.9408) && !broadcastFormat(1920,1080,p,60.0007)
                && !broadcastFormat(1920,1080,p,NAN) && !broadcastFormat(1920,1080,p | kDisplayModeStretchedFlag,59.94)
                && !broadcastFormat(1920,1080,kDisplayModeValidFlag,59.94)
                && [chooseFormat(@"auto", @[@"480i59.94", @"720p59.94", @"1080i59.94"]) isEqual:@"1080i59.94"]
                && [chooseFormat(@"auto", @[@"720p59.94", @"1080p60.00"]) isEqual:@"720p59.94"]
                && !chooseFormat(@"auto", @[@"1080p60.00"]) && !chooseFormat(@"1080p59.94", @[@"1080i59.94"]));
        }
        if (CGDisplayRegisterReconfigurationCallback(changed, NULL)) return 1;
        signal(SIGTERM, SIG_IGN);
        __attribute__((objc_precise_lifetime)) dispatch_source_t terminate = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
        dispatch_source_set_event_handler(terminate, ^{ restoreOriginal(); exit(0); });
        dispatch_activate(terminate);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            char *line = NULL;
            size_t capacity = 0;
            ssize_t length;
            while ((length = getline(&line, &capacity, stdin)) > 0) @autoreleasepool {
                NSDictionary *command = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:line length:length] options:0 error:NULL];
                if (![command isKindOfClass:NSDictionary.class] || ![command[@"format"] isKindOfClass:NSString.class]) continue;
                dispatch_async(dispatch_get_main_queue(), ^{ configure(command); });
            }
            free(line);
            dispatch_async(dispatch_get_main_queue(), ^{ restoreOriginal(); exit(0); });
        });
        [[NSRunLoop mainRunLoop] addPort:[NSPort port] forMode:NSDefaultRunLoopMode];
        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}
