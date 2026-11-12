max_threads = ENV.fetch("RAILS_MAX_THREADS", 5).to_i
threads max_threads, max_threads

environment ENV.fetch("RAILS_ENV", "development")
port = ENV.fetch("PORT", "3000")
bind "tcp://0.0.0.0:#{port}"
pidfile ENV["PIDFILE"] if ENV["PIDFILE"]

plugin :tmp_restart
