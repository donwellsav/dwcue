#undef NDEBUG
#include "crow/storage_io.h"
#include <atomic>
#include <cassert>
#include <future>
#include <latch>
#include <semaphore>
#include <vector>

int main() {
    crow::detail::StorageIo io;
    std::latch bulk_entered{2}, stream_entered{2};
    std::counting_semaphore<40> bulk_gate{0}, stream_gate{0};
    std::atomic<unsigned> completed{0};
    std::vector<std::weak_ptr<int>> owners;
    for (const bool stream : {false, true}) {
        const unsigned limit = stream ? 8 : 32;
        for (unsigned i = 0; i < limit; ++i) {
            auto owner = std::make_shared<int>(i);
            owners.emplace_back(owner);
            assert(io.submit([&, stream, i, owner] {
                if (i < 2) (stream ? stream_entered : bulk_entered).count_down();
                (stream ? stream_gate : bulk_gate).acquire();
                ++completed;
            }, stream));
        }
        assert(!io.submit([] { assert(false); }, stream));
    }
    bulk_entered.wait();
    stream_entered.wait(); // Bulk work cannot occupy the media workers.
    for (const auto& owner : owners) assert(!owner.expired());
    auto stopping = std::async(std::launch::async, [&] { io.shutdown(); });
    bulk_gate.release(32);
    stream_gate.release(8);
    stopping.get();
    assert(completed == 40);
    for (const auto& owner : owners) assert(owner.expired());
    assert(!io.submit([] { assert(false); }));
}
