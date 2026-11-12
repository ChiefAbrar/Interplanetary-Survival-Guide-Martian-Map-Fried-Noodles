Rails.application.routes.draw do
  # Load-balancer / uptime check (returns 200 when the app boots cleanly).
  get "up" => "rails/health#show", as: :rails_health_check

  root "home#index"
  get "explore" => "home#explore"
  get "regions/jezero" => "home#jezero"
  get "ctx-terrain/:file" => "ctx_terrain#show", constraints: { file: /catalog\.json|ctx_r\d{3}_c\d{3}\.(?:json|f32)/ }
end
