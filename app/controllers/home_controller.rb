class HomeController < ApplicationController
  def index
    expires_in 5.minutes, public: true
  end

  def explore
    expires_in 5.minutes, public: true
    render :index
  end

  def jezero
    expires_in 5.minutes, public: true
    render :index
  end

end
