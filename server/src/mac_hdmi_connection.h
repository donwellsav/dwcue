// Quartz can omit a fractional HDMI connection mode even while the driver
// advertises it. Use QuartzCore only with an identifiable HDMI framebuffer.
#import <IOKit/IOKitLib.h>
#include <dlfcn.h>

@interface NSObject (CueDisplayConnection)
+ (NSArray *)displays;
- (unsigned)displayId;
- (id)UUID;
- (NSArray *)availableModes;
- (id)currentMode;
- (void)setCurrentMode:(id)mode;
- (NSUInteger)width;
- (NSUInteger)height;
- (double)refreshRate;
- (id)colorMode;
- (id)hdrMode;
- (BOOL)isVRR;
@end

static NSDictionary *connectionDescription(id mode) {
    if (![mode respondsToSelector:@selector(isVRR)] || [mode isVRR]) return nil;
    double hz = [mode refreshRate];
    if (!isfinite(hz) || hz <= 0) return nil;
    NSString *color = [[mode colorMode] description];
    NSString *hdr = [[mode hdrMode] description];
    return @{@"width": @([mode width]), @"height": @([mode height]), @"nominalHz": @(hz),
             @"color": color ? color : @"", @"hdr": hdr ? hdr : @""};
}

static id hdmiDisplay(CGDirectDisplayID displayID) {
#if defined(__arm64__)
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        dlopen("/System/Library/Frameworks/QuartzCore.framework/QuartzCore", RTLD_LAZY | RTLD_LOCAL);
    });
    Class displayClass = NSClassFromString(@"CADisplay");
    if ([displayClass respondsToSelector:@selector(displays)]) {
        for (id display in [displayClass displays]) {
            if ([display displayId] == displayID && [display respondsToSelector:@selector(availableModes)] &&
                [display respondsToSelector:@selector(setCurrentMode:)] && [display respondsToSelector:@selector(UUID)]) return display;
        }
    }
#endif
    return nil;
}

static id registryProperty(io_service_t service, CFStringRef key) {
    return CFBridgingRelease(IORegistryEntryCreateCFProperty(service, key, NULL, 0));
}

static NSDictionary *hdmiLink(CGDirectDisplayID displayID) {
    id display = hdmiDisplay(displayID);
    NSString *uuid = [[display UUID] description];
    if (!uuid.length) return nil;
    io_iterator_t iterator;
    if (IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOMobileFramebufferShim"), &iterator)) return nil;
    io_service_t service, target = 0;
    while ((service = IOIteratorNext(iterator))) {
        BOOL matches = [registryProperty(service, CFSTR("external")) isEqual:@YES] &&
            [registryProperty(service, CFSTR("IOMFBUUID")) isEqual:uuid] &&
            [registryProperty(service, CFSTR("Transport"))[@"Downstream"] isEqual:@"HDMI"];
        if (matches && !target) { target = service; continue; }
        IOObjectRelease(service);
        if (matches) { IOObjectRelease(target); target = 0; break; }
    }
    IOObjectRelease(iterator);
    if (!target) return nil;
    NSNumber *timingID = registryProperty(target, CFSTR("DPTimingModeId"));
    NSArray *timings = registryProperty(target, CFSTR("TimingElements"));
    IOObjectRelease(target);
    if (!timingID || ![timings isKindOfClass:NSArray.class]) return @{};
    BOOL offersExact = NO;
    NSDictionary *signal = nil;
    for (NSDictionary *timing in timings) {
        if ([timing[@"IsVirtual"] boolValue]) continue;
        NSDictionary *h = timing[@"HorizontalAttributes"], *v = timing[@"VerticalAttributes"];
        NSUInteger width = [h[@"Active"] unsignedIntegerValue], height = [v[@"Active"] unsignedIntegerValue];
        double hz = [v[@"PreciseSyncRate"] doubleValue] / 65536.0;
        BOOL interlaced = [timing[@"IsInterlaced"] boolValue];
        NSUInteger vic = [timing[@"CEAShortID"] unsignedIntegerValue];
        BOOL exact = width == 1920 && height == 1080 && !interlaced && vic == 16 &&
            [h[@"Total"] unsignedIntegerValue] == 2200 && [v[@"Total"] unsignedIntegerValue] == 1125 &&
            fabs(hz - 60000./1001) <= 1./65536;
        offersExact |= exact;
        if ([timing[@"ID"] isEqual:timingID] && width && height && hz > 0) {
            NSString *format = vic ? broadcastFormat(width, height, kDisplayModeTelevisionFlag | kDisplayModeValidFlag |
                (interlaced ? kDisplayModeInterlacedFlag : 0), hz) : nil;
            if ([format isEqual:@"1080p59.94"] && !exact) format = nil;
            signal = @{@"width": @(width), @"height": @(height), @"hz": @(hz),
                       @"format": format ? format : @"", @"interlaced": @(interlaced)};
        }
    }
    NSDictionary *mode = connectionDescription([display currentMode]);
    return @{@"uuid": uuid, @"exact1080": @(offersExact),
             @"signal": signal ? signal : @{}, @"mode": mode ? mode : @{}};
}

static id hdmiMode(id display, NSDictionary *description) {
    id found = nil;
    for (id mode in [display availableModes]) {
        if (![connectionDescription(mode) isEqual:description]) continue;
        if (found) return nil;
        found = mode;
    }
    return found;
}

static NSDictionary *exact1080Connection(CGDirectDisplayID displayID, NSDictionary *link) {
    NSDictionary *current = link[@"mode"];
    if (![link[@"exact1080"] boolValue] || !current.count) return nil;
    id display = hdmiDisplay(displayID);
    if (![[[display UUID] description] isEqual:link[@"uuid"]]) return nil;
    NSDictionary *found = nil;
    for (id mode in [display availableModes]) {
        NSDictionary *desc = connectionDescription(mode);
        double hz = [desc[@"nominalHz"] doubleValue];
        if ([desc[@"width"] intValue] != 1920 || [desc[@"height"] intValue] != 1080 ||
            fmin(fabs(hz - 59.94), fabs(hz - 60000./1001)) > 1./65536 ||
            ![desc[@"color"] isEqual:current[@"color"]] || ![desc[@"hdr"] isEqual:current[@"hdr"]]) continue;
        if (found) return nil;
        found = desc;
    }
    return found;
}
