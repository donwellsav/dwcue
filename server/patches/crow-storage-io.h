#pragma once
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#ifdef CROW_USE_BOOST
#include <boost/asio/post.hpp>
#include <boost/asio/thread_pool.hpp>
#else
#include <asio/post.hpp>
#include <asio/thread_pool.hpp>
#endif

namespace crow::detail {
#ifdef CROW_USE_BOOST
namespace storage_asio = boost::asio;
#else
namespace storage_asio = ::asio;
#endif

class StorageIo {
public:
    bool submit(std::function<void()> work, bool stream = false) {
        std::lock_guard lock{mutex_};
        auto& pending = stream ? pending_stream_ : pending_;
        if (closing_ || pending.load() >= (stream ? 8u : 32u)) return false;
        ++pending;
        auto permit = std::shared_ptr<void>(this, [&pending](void*) { --pending; });
        storage_asio::post(stream ? stream_pool_ : pool_,
            [work = std::move(work), permit = std::move(permit)] { work(); });
        return true;
    }

    void shutdown() {
        {
            std::lock_guard lock{mutex_};
            closing_ = true;
        }
        // Drain admitted work before its request/response owners disappear.
        pool_.join();
        stream_pool_.join();
    }

private:
    std::mutex mutex_;
    bool closing_ = false;
    std::atomic<unsigned> pending_{0};
    std::atomic<unsigned> pending_stream_{0};
    // shortcut: 2 workers each, 8 stream/32 bulk admissions; profile before raising the bounds.
    storage_asio::thread_pool pool_{2};
    storage_asio::thread_pool stream_pool_{2};
};
} // namespace crow::detail
