class CtxTerrainController < ApplicationController
  TILE_ROOT = Rails.root.join("data/processed/ctx-jezero").freeze

  def show
    file = params[:file].to_s
    unless file == "catalog.json" || file.match?(/\Actx_r\d{3}_c\d{3}\.(?:json|f32)\z/)
      head :not_found
      return
    end

    path = TILE_ROOT.join(file)
    unless path.file?
      head :not_found
      return
    end

    expires_in 1.hour, public: true
    send_file path, type: file.end_with?(".f32") ? "application/octet-stream" : "application/json", disposition: "inline"
  end
end
